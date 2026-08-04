import { existsSync, accessSync, constants } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { ProjectLoaderError } from "./errors.js";

const ENV_VAR = "STORYBLOQ_PROJECT_ROOT";
const LEGACY_ENV_VAR = "CLAUDESTORY_PROJECT_ROOT";
const STORY_DIR = ".story";
const CONFIG_PATH = ".story/config.json";

/**
 * Discovers the project root by walking up from `startDir` (default: cwd)
 * looking for `.story/config.json`.
 *
 * STORYBLOQ_PROJECT_ROOT env var overrides walk-up discovery.
 * CLAUDESTORY_PROJECT_ROOT is retained as a deprecated fallback.
 * Returns the canonical absolute path, or null if not found.
 * Throws ProjectLoaderError if .story/ exists but is unreadable.
 */
export function discoverProjectRoot(startDir?: string): string | null {
  // 1. Check env var override
  const envRoot = process.env[ENV_VAR] ?? process.env[LEGACY_ENV_VAR];
  if (envRoot) {
    const resolved = resolve(envRoot);
    return checkRoot(resolved);
  }

  // 2. Walk up from startDir
  let current = resolve(startDir ?? process.cwd());

  for (;;) {
    const result = checkRoot(current);
    if (result) return result;
    const parent = dirname(current);
    if (parent === current) break; // filesystem root reached
    current = parent;
  }

  return null;
}

/** Returns root if config.json found, throws on permission errors, null otherwise. */
function checkRoot(candidate: string): string | null {
  if (existsSync(join(candidate, CONFIG_PATH))) {
    return candidate;
  }
  // .story/ exists but config.json not readable -- check if it's a permission issue
  if (existsSync(join(candidate, STORY_DIR))) {
    try {
      accessSync(join(candidate, STORY_DIR), constants.R_OK);
    } catch {
      throw new ProjectLoaderError(
        "io_error",
        `Permission denied: cannot read .story/ in ${candidate}`,
      );
    }
  }
  return null;
}
