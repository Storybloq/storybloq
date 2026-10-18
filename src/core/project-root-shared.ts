/**
 * Dependency-free project-root discovery.
 *
 * Extracted from `project-root-discovery.ts` so the presence hook entry
 * (`src/hooks/presence-entry.ts`) can resolve a project root without importing
 * anything that pulls in the CLI dispatcher, the MCP server or ProjectState.
 * That entry is spawned twice per tool call, so its whole import graph is
 * `node:fs`, `node:path` and this file.
 *
 * Extracted rather than copied on purpose: env-var override precedence and
 * walk-up semantics are a contract shared with the MCP/CLI reader, and two
 * copies would drift silently the first time either changed.
 */

import { existsSync, accessSync, constants, lstatSync } from "node:fs";
import { resolve, dirname, join, relative, isAbsolute, sep } from "node:path";

export const PROJECT_ROOT_ENV_VAR = "STORYBLOQ_PROJECT_ROOT";
export const LEGACY_PROJECT_ROOT_ENV_VAR = "CLAUDESTORY_PROJECT_ROOT";

const STORY_DIR = ".story";
const CONFIG_PATH = ".story/config.json";

export interface DiscoverProjectRootOptions {
  /**
   * Invoked when `.story/` exists at a candidate but is not readable. The
   * caller decides the policy: `project-root-discovery.ts` throws a
   * ProjectLoaderError from here; a caller that supplies nothing (the presence
   * hook, which must never fail a tool call over an unreadable directory) gets
   * a soft `null` instead.
   */
  onUnreadableStoryDir?: (candidate: string) => void;
  /**
   * Walk from `startDir` even when a project-root variable is set. For a
   * caller asking what ANOTHER process, launched without this one's
   * environment, will find there (ISS-1305: `duet spawn` classifying a
   * worker's directory from inside a session that itself runs under the
   * override).
   */
  ignoreEnv?: boolean;
  /** Inclusive discovery boundary for a task-bound local integration. */
  boundary?: string;
  /** Stop at an existing ledger that has no readable config instead of walking past it. */
  onIncompleteStoryDir?: (candidate: string) => void;
}

type RootCheck =
  | { readonly kind: "found"; readonly root: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "miss" };

/**
 * Walks up from `startDir` (default: cwd) looking for `.story/config.json`.
 *
 * STORYBLOQ_PROJECT_ROOT overrides the walk; CLAUDESTORY_PROJECT_ROOT is the
 * deprecated fallback. Returns the resolved absolute path, or null.
 */
export function discoverProjectRootShared(
  startDir?: string,
  options?: DiscoverProjectRootOptions,
): string | null {
  const envRoot = options?.ignoreEnv ? undefined : process.env[PROJECT_ROOT_ENV_VAR] ?? process.env[LEGACY_PROJECT_ROOT_ENV_VAR];
  if (envRoot) {
    const result = checkRoot(resolve(envRoot), options);
    return result.kind === "found" ? result.root : null;
  }

  let current = resolve(startDir ?? process.cwd());
  const boundary = options?.boundary ? resolve(options.boundary) : undefined;
  if (boundary) {
    const rel = relative(boundary, current);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Project discovery starts outside its boundary");
  }

  for (;;) {
    const result = checkRoot(current, options);
    if (result.kind === "found") return result.root;
    // An unreadable `.story/` is a TERMINAL boundary, not a miss. Walking past
    // it would resolve a NESTED project to whichever ancestor project happens
    // to sit above it, and every consumer then treats the inner project's
    // activity as the outer one's: the presence hook would file a session's
    // tool metadata into a different project's telemetry, and prove path
    // containment against the wrong root. Callers that raise (the CLI wrapper)
    // never reach this line; callers that do not get a soft null.
    if (result.kind === "unreadable") return null;
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break; // filesystem root reached
    current = parent;
  }

  return null;
}

/** Found, an unreadable `.story/` boundary, or neither. */
function checkRoot(candidate: string, options?: DiscoverProjectRootOptions): RootCheck {
  if (options?.onIncompleteStoryDir) {
    let entry;
    try {
      entry = lstatSync(join(candidate, STORY_DIR));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        options.onUnreadableStoryDir?.(candidate);
        return { kind: "unreadable" };
      }
    }
    // A dangling symlink still owns this ledger location. Walking past it
    // could silently bind this task to another project's ancestor ledger.
    if (entry && !entry.isDirectory()) {
      options.onIncompleteStoryDir(candidate);
      return { kind: "unreadable" };
    }
  }
  if (existsSync(join(candidate, CONFIG_PATH))) {
    return { kind: "found", root: candidate };
  }
  // .story/ exists but config.json not readable -- check if it's a permission issue
  if (existsSync(join(candidate, STORY_DIR))) {
    try {
      accessSync(join(candidate, STORY_DIR), constants.R_OK);
    } catch {
      options?.onUnreadableStoryDir?.(candidate);
      return { kind: "unreadable" };
    }
    if (options?.onIncompleteStoryDir) {
      options.onIncompleteStoryDir(candidate);
      return { kind: "unreadable" };
    }
  }
  return { kind: "miss" };
}
