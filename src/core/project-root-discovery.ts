import { ProjectLoaderError } from "./errors.js";
import { discoverProjectRootShared } from "./project-root-shared.js";

export {
  PROJECT_ROOT_ENV_VAR,
  LEGACY_PROJECT_ROOT_ENV_VAR,
  discoverProjectRootShared,
} from "./project-root-shared.js";

/**
 * Discovers the project root by walking up from `startDir` (default: cwd)
 * looking for `.story/config.json`.
 *
 * STORYBLOQ_PROJECT_ROOT env var overrides walk-up discovery.
 * CLAUDESTORY_PROJECT_ROOT is retained as a deprecated fallback.
 * Returns the canonical absolute path, or null if not found.
 * Throws ProjectLoaderError if .story/ exists but is unreadable.
 *
 * The walk itself lives in `project-root-shared.ts`, which imports nothing but
 * `node:fs`/`node:path` so the presence hook entry can reuse it; this wrapper
 * adds the throwing policy that CLI/MCP callers expect.
 */
export function discoverProjectRoot(startDir?: string): string | null {
  return discoverProjectRootShared(startDir, {
    onUnreadableStoryDir: (candidate) => {
      throw new ProjectLoaderError(
        "io_error",
        `Permission denied: cannot read .story/ in ${candidate}`,
      );
    },
  });
}
