/**
 * ISS-570 G3: Skill-dir version marker + silent auto-refresh.
 *
 * The Storybloq skill is installed into per-client skill directories. After
 * `storybloq setup --client ...`, the skill contains a copy of SKILL.md,
 * setup-flow.md, autonomous-mode.md, reference.md, and review-lenses content
 * from whichever version of the CLI wrote them.
 *
 * When a user runs `npm install -g @storybloq/storybloq@latest`, the CLI
 * binary updates but the skill dir stays on the OLD skill files until
 * `storybloq setup --client claude` is re-run. Easy to forget.
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

export type SkillInstallTarget = "claude" | "codex" | "codexCompat";

export interface SkillTargetInfo {
  readonly id: SkillInstallTarget;
  readonly client: "claude" | "codex";
  readonly dir: string;
  readonly displayPath: string;
}

function targetInfo(target: SkillInstallTarget): SkillTargetInfo {
  switch (target) {
    case "claude":
      return {
        id: target,
        client: "claude",
        dir: join(homedir(), ".claude", "skills", "story"),
        displayPath: "~/.claude/skills/story/",
      };
    case "codex":
      return {
        id: target,
        client: "codex",
        dir: join(homedir(), ".agents", "skills", "story"),
        displayPath: "~/.agents/skills/story/",
      };
    case "codexCompat": {
      const codexHome = process.env.CODEX_HOME;
      return {
        id: target,
        client: "codex",
        dir: join(codexHome ?? join(homedir(), ".codex"), "skills", "story"),
        displayPath: codexHome ? "$CODEX_HOME/skills/story/" : "~/.codex/skills/story/",
      };
    }
  }
}

/** ISS-1091 (F10): exported so the e2e acceptance probe's audited-path list can enumerate targets by walking this, instead of hand-duplicating the id list. */
export function skillTargets(): readonly SkillTargetInfo[] {
  return [targetInfo("claude"), targetInfo("codex"), targetInfo("codexCompat")];
}

export function skillDir(target: SkillInstallTarget = "claude"): string {
  return targetInfo(target).dir;
}

function markerPath(target: SkillInstallTarget = "claude"): string {
  return join(skillDir(target), MARKER_FILE);
}

/** Read the CLI version that last wrote the skill dir. null if missing. */
export function readSkillMarker(target: SkillInstallTarget = "claude"): string | null {
  try {
    const p = markerPath(target);
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf-8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Write the CLI version marker. Best-effort; errors are swallowed. */
export function writeSkillMarker(version: string, target: SkillInstallTarget = "claude"): void {
  try {
    mkdirSync(skillDir(target), { recursive: true });
    writeFileSync(markerPath(target), version + "\n", "utf-8");
  } catch {
    // Marker write is best-effort.
  }
}

/** True when the skill dir exists AND the marker is stale or missing. */
export function isSkillStale(runningVersion: string, target: SkillInstallTarget = "claude"): boolean {
  if (!runningVersion || runningVersion === "0.0.0-dev") return false;
  if (!existsSync(join(skillDir(target), "SKILL.md"))) return false; // no skill dir = not stale, just uninstalled
  const marker = readSkillMarker(target);
  return marker !== runningVersion;
}

/**
 * ISS-1091 (F10): exported for the e2e acceptance probe's audited-path list.
 * Note this duplicates setup-skill.ts's own `codexConfigPath` -- both compute
 * the identical path independently; see test/helpers/e2e-acceptance-probe.test.ts
 * for the pinned-equal assertion documenting that duplication.
 */
export function codexConfigPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

function hasCodexStorybloqServer(configPath: string): boolean {
  try {
    const raw = readFileSync(configPath, "utf-8");
    return /^\s*\[mcp_servers\.storybloq\]\s*(?:#.*)?$/m.test(raw);
  } catch {
    return false;
  }
}

async function refreshCodexConfigIfPresent(): Promise<void> {
  const configPath = codexConfigPath();
  if (!existsSync(configPath)) return;
  if (!hasCodexStorybloqServer(configPath)) return;

  try {
    const { ensureCodexClientEnv } = await import("../cli/commands/setup-skill.js");
    const env = await ensureCodexClientEnv(configPath);
    if (env === "updated") {
      process.stderr.write("storybloq: refreshed Codex Storybloq MCP config on version advance\n");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `storybloq: Codex MCP config refresh failed (non-fatal): ${msg}\n` +
      `  Run 'storybloq setup --client codex' manually to retry.\n`,
    );
  }
}

/**
 * Silently refresh skill files when the marker is stale.
 *
 * Returns true if a refresh was performed, false otherwise. Prints one
 * line to stderr on success so users see what happened without being
 * spammed with the full setup output.
 *
 * Errors are logged to stderr but do not throw -- a stale skill dir is
 * a UX degradation, not a blocker. The user's original command still
 * runs.
 */
export async function autoRefreshSkillIfStale(
  runningVersion: string,
  opts: { reconcileLimitHooks?: boolean } = {},
): Promise<boolean> {
  // Default true for ordinary upgrades; a `setup --skip-hooks` invocation
  // passes false so the version refresh does not install limit hooks the user
  // explicitly opted out of.
  const reconcileLimitHooks = opts.reconcileLimitHooks !== false;
  const staleTargets = skillTargets().filter((target) => isSkillStale(runningVersion, target.id));
  if (staleTargets.length === 0) return false;

  try {
    const { copyDirRecursive, resolveSkillSourceDir, resolveStorybloqBin } =
      await import("../cli/commands/setup-skill.js");
    const src = resolveSkillSourceDir();
    let refreshedClaude = false;
    let refreshedCodex = false;

    for (const target of staleTargets) {
      await copyDirRecursive(src, target.dir);
      writeSkillMarker(runningVersion, target.id);
      refreshedClaude = refreshedClaude || target.client === "claude";
      refreshedCodex = refreshedCodex || target.client === "codex";
      process.stderr.write(
        `storybloq: refreshed skill files at ${target.displayPath} to match CLI v${runningVersion}\n`,
      );
    }

    if (refreshedCodex) {
      await refreshCodexConfigIfPresent();
      try {
        const { refreshExistingCodexHooks, resolveStorybloqBin } =
          await import("../cli/commands/setup-skill.js");
        const bin = resolveStorybloqBin();
        if (bin !== null) {
          const codexHookRefresh = await refreshExistingCodexHooks(bin);
          if (codexHookRefresh.changed > 0) {
            process.stderr.write(
              `storybloq: refreshed ${codexHookRefresh.changed} Codex hook entr${codexHookRefresh.changed === 1 ? "y" : "ies"} on version advance\n`,
            );
          }
        }
      } catch (codexHookErr: unknown) {
        const codexHookMsg = codexHookErr instanceof Error ? codexHookErr.message : String(codexHookErr);
        process.stderr.write(
          `storybloq: Codex hook refresh failed (non-fatal): ${codexHookMsg}\n` +
          `  Run 'storybloq setup --client codex' manually to retry.\n`,
        );
      }
    }

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
    const bin = refreshedClaude ? resolveStorybloqBin() : null;
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
          `  Run 'storybloq setup --client all' manually to retry.\n`,
        );
      }

      // T-424: reconcile the limit-stop hooks (not count-gated: the legacy
      // sweep only touches existing entries and can never install an absent
      // hook type, so upgrades would otherwise never add StopFailure to the
      // installed base). Honors the global kill switch (disabled => removed)
      // AND a `setup --skip-hooks` opt-out (reconcileLimitHooks === false).
      if (reconcileLimitHooks) {
        try {
          const { ensureLimitHooksRegistered } = await import("../cli/commands/setup-skill.js");
          const limitHooks = await ensureLimitHooksRegistered(undefined, bin);
          if (limitHooks.action === "installed") {
            process.stderr.write("storybloq: registered limit-stop auto-resume hooks on version advance\n");
          } else if (limitHooks.action === "removed") {
            process.stderr.write("storybloq: removed limit-stop hooks (auto-resume disabled globally)\n");
          }
        } catch (limitErr: unknown) {
          const limitMsg = limitErr instanceof Error ? limitErr.message : String(limitErr);
          process.stderr.write(
            `storybloq: limit-stop hook reconcile failed (non-fatal): ${limitMsg}\n`,
          );
        }
      }
    }

    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `storybloq: skill refresh failed (non-fatal): ${msg}\n` +
      `  Run 'storybloq setup --client all' manually to sync.\n`,
    );
    return false;
  }
}
