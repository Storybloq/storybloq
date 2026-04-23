/**
 * ISS-570 G3: Skill-dir version marker + silent auto-refresh.
 *
 * The /story skill lives at ~/.claude/skills/story/. After `storybloq
 * setup-skill`, the skill contains a copy of SKILL.md, setup-flow.md,
 * autonomous-mode.md, reference.md, and review-lenses content from
 * whichever version of the CLI wrote them.
 *
 * When a user runs `npm install -g @storybloq/storybloq@latest`, the CLI
 * binary updates but the skill dir stays on the OLD skill files until
 * `storybloq setup-skill` is re-run. Easy to forget.
 *
 * This module writes a small `.storybloq-version` text file into the
 * skill dir recording the CLI version that generated it. On every CLI
 * invocation, we compare that marker to the running CLI version; if
 * they differ, we re-copy the skill files silently and write a single
 * stderr line noting what happened.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MARKER_FILE = ".storybloq-version";

function skillDir(): string {
  return join(homedir(), ".claude", "skills", "story");
}

function markerPath(): string {
  return join(skillDir(), MARKER_FILE);
}

/** Read the CLI version that last wrote the skill dir. null if missing. */
export function readSkillMarker(): string | null {
  try {
    const p = markerPath();
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf-8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Write the CLI version marker. Best-effort; errors are swallowed. */
export function writeSkillMarker(version: string): void {
  try {
    mkdirSync(skillDir(), { recursive: true });
    writeFileSync(markerPath(), version + "\n", "utf-8");
  } catch {
    // Marker write is best-effort.
  }
}

/** True when the skill dir exists AND the marker is stale or missing. */
export function isSkillStale(runningVersion: string): boolean {
  if (!runningVersion || runningVersion === "0.0.0-dev") return false;
  if (!existsSync(join(skillDir(), "SKILL.md"))) return false; // no skill dir = not stale, just uninstalled
  const marker = readSkillMarker();
  return marker !== runningVersion;
}

/**
 * Silently refresh skill files when the marker is stale.
 *
 * Returns true if a refresh was performed, false otherwise. Prints one
 * line to stderr on success so users see what happened without being
 * spammed with the full setup-skill output.
 *
 * Errors are logged to stderr but do not throw -- a stale skill dir is
 * a UX degradation, not a blocker. The user's original command still
 * runs.
 */
export async function autoRefreshSkillIfStale(runningVersion: string): Promise<boolean> {
  if (!isSkillStale(runningVersion)) return false;

  try {
    const { copyDirRecursive, resolveSkillSourceDir, resolveStorybloqBin } =
      await import("../cli/commands/setup-skill.js");
    const src = resolveSkillSourceDir();
    await copyDirRecursive(src, skillDir());
    writeSkillMarker(runningVersion);
    process.stderr.write(
      `storybloq: refreshed /story skill files at ~/.claude/skills/story/ to match CLI v${runningVersion}\n`,
    );

    // ISS-590: migrate stale legacy-basename hook entries (for example
    // claudestory-named hooks left behind after migrating from
    // @anthropologies/claudestory).
    //
    // Ordering matters for safety:
    //   1. countLegacyHooks (non-mutating) detects whether migration
    //      work is needed. If zero legacy entries, do nothing. This
    //      preserves the user's intent when they have no hooks by
    //      choice (skill-only install, deliberately removed hooks).
    //   2. Register canonical storybloq hooks FIRST. Each registerXHook
    //      is idempotent (returns "exists" if the exact command is
    //      already present). If any registration fails partway, the
    //      original legacy entries are still in place, so the user
    //      still has working hooks.
    //   3. Sweep legacy entries LAST. The worst case is a partial
    //      sweep that leaves a stale legacy entry alongside the
    //      canonical we just added. Visible noise, but still working
    //      hooks, not "no hooks at all".
    //
    // Best-effort: if the storybloq bin cannot be resolved there is
    // nothing to re-register against, and any failure logs but does
    // not block the refresh.
    const bin = resolveStorybloqBin();
    if (bin !== null) {
      try {
        const { countLegacyHooks, sweepLegacyHooks } = await import("./hook-migration.js");
        const counts = await countLegacyHooks(bin);
        const totalLegacy = counts.PreCompact + counts.SessionStart + counts.Stop;
        if (totalLegacy > 0) {
          // Register canonical hooks only for the hook types that had
          // legacy entries. Users who intentionally removed or disabled
          // specific hook types must keep those absent even during a
          // migration of another type.
          const { registerPreCompactHook, registerSessionStartHook, registerStopHook } =
            await import("../cli/commands/setup-skill.js");
          if (counts.PreCompact > 0) await registerPreCompactHook(undefined, bin);
          if (counts.SessionStart > 0) await registerSessionStartHook(undefined, bin);
          if (counts.Stop > 0) await registerStopHook(undefined, bin);
          const swept = await sweepLegacyHooks(bin);
          if (swept > 0) {
            process.stderr.write(
              `storybloq: swept ${swept} legacy hook entr${swept === 1 ? "y" : "ies"} on version advance\n`,
            );
          }
        }
      } catch (sweepErr: unknown) {
        const sweepMsg = sweepErr instanceof Error ? sweepErr.message : String(sweepErr);
        process.stderr.write(
          `storybloq: legacy hook sweep or register failed (non-fatal): ${sweepMsg}\n` +
          `  Run 'storybloq setup-skill' manually to retry.\n`,
        );
      }
    }

    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `storybloq: skill refresh failed (non-fatal): ${msg}\n` +
      `  Run 'storybloq setup-skill' manually to sync.\n`,
    );
    return false;
  }
}
