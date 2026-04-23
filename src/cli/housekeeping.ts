/**
 * Pre-command housekeeping: silent operations that run on every CLI
 * invocation before the user's command dispatches. Extracted from
 * cli/index.ts so the real startup path can be exercised by tests
 * without triggering the top-level `runCli()` side effect.
 *
 * Currently:
 *   - ISS-570 G3: auto-refresh /story skill files when the CLI version
 *     differs from the skill-dir marker.
 *   - ISS-590: legacy hook sweep runs inside autoRefreshSkillIfStale
 *     when the marker advances.
 *   - ISS-570 G1: kick off a background npm-registry check so the
 *     next invocation has fresh update-available data.
 *
 * Best-effort: never blocks the user's command and never throws.
 */
export async function preCommandHousekeeping(version: string): Promise<void> {
  if (!version || version === "0.0.0-dev") return;
  try {
    const { autoRefreshSkillIfStale } = await import("../core/skill-version-marker.js");
    await autoRefreshSkillIfStale(version);
  } catch {
    // Best-effort; never block the user's command.
  }
  try {
    const { refreshUpdateCacheInBackground } = await import("../core/update-check.js");
    refreshUpdateCacheInBackground();
  } catch {
    // Best-effort.
  }
}
