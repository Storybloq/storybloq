/**
 * ISS-1408: `claude plugin validate`, run against one named client so that a
 * stale claude earlier on PATH can never stand in for it. The client is
 * STORYBLOQ_TEST_CLAUDE when set (an absolute path), else the claude installed
 * beside the node running the tests; PATH is never searched. Its version is
 * read before validation, and the same path is then executed. A failure names
 * the path, its version and what validate printed, since a bare execFileSync
 * failure reports only "Command failed".
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * The version this suite was proven against, not a researched minimum: the
 * failure ISS-1408 guards is an older client shadowing a current one. Raising
 * it is a deliberate edit.
 */
export const MIN_CLAUDE_VERSION = "2.1.303";

export const CLAUDE_PATH_ENV = "STORYBLOQ_TEST_CLAUDE";

export type ClaudeResolution =
  | { readonly found: true; readonly path: string; readonly version: string }
  | { readonly found: false; readonly reason: string };

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Names the client to run. Not found only when the variable is unset and no
 * claude sits beside node; every other problem throws, so a misconfigured or
 * outdated client fails loudly instead of being skipped or replaced.
 */
export function resolveClaude(env: NodeJS.ProcessEnv, nodePath: string = process.execPath): ClaudeResolution {
  const configured = env[CLAUDE_PATH_ENV];
  const besideNode = join(dirname(nodePath), "claude");
  let path: string;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error(`${CLAUDE_PATH_ENV} must be an absolute path, got "${configured}"`);
    if (!executable(configured)) throw new Error(`${CLAUDE_PATH_ENV}=${configured} is not an executable file`);
    path = configured;
  } else if (existsSync(besideNode)) {
    if (!executable(besideNode)) throw new Error(`${besideNode} is not an executable file`);
    path = besideNode;
  } else {
    return { found: false, reason: `no claude: ${CLAUDE_PATH_ENV} is unset and ${besideNode} does not exist (PATH is not searched)` };
  }
  const run = spawnSync(path, ["--version"], { encoding: "utf8", env });
  const line = firstLine(run.stdout ?? "");
  const match = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(line);
  if (run.error !== undefined || run.status !== 0 || match === null) {
    throw new Error(`${path} --version did not identify Claude Code (exit ${run.status}): "${line}"`);
  }
  if (!atLeast(match[1]!, MIN_CLAUDE_VERSION)) {
    throw new Error(`${path} is Claude Code ${match[1]}, older than the ${MIN_CLAUDE_VERSION} this suite was proven against`);
  }
  return { found: true, path, version: line };
}

/** Returns validate's stdout on exit 0; throws an Error carrying the diagnostics otherwise. */
export function claudeValidate(dir: string, env: NodeJS.ProcessEnv, nodePath: string = process.execPath): string {
  const claude = resolveClaude(env, nodePath);
  if (!claude.found) throw new Error(claude.reason);
  const run = spawnSync(claude.path, ["plugin", "validate", dir], { encoding: "utf8", env });
  if (run.error === undefined && run.status === 0) return run.stdout;
  const exit = run.error !== undefined ? `spawn error ${run.error.message}` : run.status === null ? `signal ${run.signal}` : `exit ${run.status}`;
  throw new Error(
    [
      `claude plugin validate ${dir} failed (${exit})`,
      `claude: ${claude.path}`,
      `version: ${claude.version}`,
      `stdout:\n${run.stdout ?? ""}`,
      `stderr:\n${run.stderr ?? ""}`,
    ].join("\n"),
  );
}
