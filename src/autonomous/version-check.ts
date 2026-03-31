/**
 * ISS-076: Version mismatch detection for MCP server advisory.
 *
 * Compares the running server version (baked at build time) against the
 * installed version (read from package.json on disk). If they differ,
 * returns a warning string for inclusion in guide instructions.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compare running version against installed version.
 * Returns a warning string if they differ, null otherwise.
 */
export function checkVersionMismatch(
  runningVersion: string,
  installedVersion: string | null,
): string | null {
  if (!installedVersion) return null;
  if (runningVersion === "0.0.0-dev") return null;
  if (runningVersion === installedVersion) return null;

  return `claudestory MCP server is running v${runningVersion} but v${installedVersion} is installed. Restart Claude Code to load the updated version.`;
}

/**
 * Read the installed version from package.json on disk.
 * Returns null if the file can't be read (graceful degradation).
 */
export function getInstalledVersion(): string | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // From src/autonomous/version-check.ts -> ../../package.json
    // From dist/mcp.js -> ../package.json
    // Try both paths
    const candidates = [
      join(dirname(thisFile), "..", "..", "package.json"),
      join(dirname(thisFile), "..", "package.json"),
    ];
    for (const candidate of candidates) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        const pkg = JSON.parse(raw) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch { /* try next */ }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the running server version from the build-time constant.
 */
export function getRunningVersion(): string {
  return process.env.CLAUDESTORY_VERSION ?? "0.0.0-dev";
}
