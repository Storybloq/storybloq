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
 *
 * ISS-1302: a rebuild does not move the version (the build injects
 * package.json's), so the marker alone kept a copy from before a skill change
 * current for as long as the version held. A sidecar beside it,
 * `.storybloq-skill-fingerprint`, records a content fingerprint of the bundle
 * the copy was written from, and at an equal plain version that fingerprint
 * decides. The marker stays one version line so an older CLI and the health
 * check keep reading it as they always have.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { compareVersionStrings } from "./team-capabilities.js";
import { readBoundedFile } from "./bounded-read.js";

/** T-502: exported so the health check's default adapter reads the same file name. */
export const SKILL_MARKER_FILE = ".storybloq-version";
const MARKER_FILE = SKILL_MARKER_FILE;

/** ISS-1302: the bundle fingerprint sidecar, one `sha256:<hex>` line beside the version marker. */
export const SKILL_FINGERPRINT_FILE = ".storybloq-skill-fingerprint";
const FINGERPRINT_SHAPE = /^sha256:[0-9a-f]{64}$/;

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

/**
 * Read the CLI version that last wrote the skill dir. null if missing.
 *
 * T-502: bounded (`readBoundedFile`), so the shared path cannot hang on a
 * FIFO left at the marker's name or slurp an oversized replacement. The
 * marker is a single version string; the 64 KiB cap is orders of magnitude
 * above anything legitimate.
 */
export const SKILL_MARKER_MAX_BYTES = 65_536;

export function readSkillMarker(target: SkillInstallTarget = "claude"): string | null {
  try {
    const p = markerPath(target);
    if (!existsSync(p)) return null;
    const body = readBoundedFile(p, SKILL_MARKER_MAX_BYTES);
    if (body === null) return null;
    const text = body.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * ISS-1302: the fingerprint of a skill source dir. It covers exactly what the
 * refresh copies (every regular file, symlinks skipped), each by its relative
 * path and its bytes, in sorted path order, so a renamed, added, removed or
 * edited file all move it. null when the dir cannot be read.
 */
export function skillSourceFingerprint(dir: string): string | null {
  try {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const parent = (entry as { parentPath?: string; path?: string }).parentPath
        ?? (entry as { path?: string }).path ?? dir;
      files.push(relative(dir, join(parent, entry.name)).split(sep).join("/"));
    }
    files.sort();
    const hash = createHash("sha256");
    for (const rel of files) {
      const bytes = readFileSync(join(dir, rel));
      hash.update(rel);
      hash.update("\0");
      hash.update(String(bytes.length));
      hash.update("\0");
      hash.update(bytes);
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return null;
  }
}

/** ISS-1302: the fingerprint recorded beside the marker. null when missing or malformed. */
export function readSkillFingerprint(target: SkillInstallTarget = "claude"): string | null {
  try {
    const p = join(skillDir(target), SKILL_FINGERPRINT_FILE);
    if (!existsSync(p)) return null;
    const text = readBoundedFile(p, SKILL_MARKER_MAX_BYTES)?.trim() ?? "";
    return FINGERPRINT_SHAPE.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Write the CLI version marker and, beside it, the fingerprint of the bundle
 * the copy was written from (ISS-1302). A null fingerprint removes the
 * sidecar, so it never describes another copy than the marker does.
 * Best-effort; errors are swallowed.
 */
export function writeSkillMarker(version: string, target: SkillInstallTarget, fingerprint: string | null): void {
  try {
    mkdirSync(skillDir(target), { recursive: true });
    writeFileSync(markerPath(target), version + "\n", "utf-8");
  } catch {
    // Marker write is best-effort.
    return;
  }
  try {
    const sidecar = join(skillDir(target), SKILL_FINGERPRINT_FILE);
    if (fingerprint === null) rmSync(sidecar, { force: true });
    else writeFileSync(sidecar, fingerprint + "\n", "utf-8");
  } catch {
    // Sidecar write is best-effort: a missing one refreshes once.
  }
}

/**
 * ISS-1091 (R4, round-3 final form): the auto-refresh path must never
 * downgrade. A missing or genuinely unparseable marker is treated as stale
 * (today's behavior, unchanged). Otherwise a non-plain (prerelease/build-
 * tagged) RUNNING version fails closed -- it never refreshes anything,
 * since refreshing FROM a plain marker TO an unshippable local prerelease
 * is never correct. A plain running version compares against the marker's
 * numeric core: strictly newer refreshes, strictly older never refreshes
 * (closes the round-3 blocker: a plain CLI must not refresh backward over
 * an intentionally-installed newer prerelease), and an equal core refreshes
 * only when the marker itself carried a prerelease/build suffix (a release
 * finalizing its own prerelease).
 *
 * ISS-1302: at an equal core with a plain marker, `content` decides: the copy
 * refreshes when its recorded fingerprint differs from the bundle's, a
 * missing or malformed record included (a copy from before the sidecar,
 * once). A bundle whose fingerprint could not be computed proves nothing and
 * never refreshes. Every version rule above is unchanged, so an older CLI
 * still never writes over a newer copy.
 */
export interface SkillContentFingerprints {
  readonly installed: string | null;
  readonly bundled: string | null;
}

export function shouldRefresh(runningVersion: string, marker: string | null, content?: SkillContentFingerprints): boolean {
  const PLAIN = /^\d+\.\d+\.\d+$/;
  const CORE_MATCH = /^(\d+\.\d+\.\d+)([-+].*)?$/;
  if (marker === null) return true; // no marker: today's behavior, unchanged
  if (!PLAIN.test(runningVersion)) return false; // non-plain running version: fail closed, never refresh
  const parsed = CORE_MATCH.exec(marker);
  if (!parsed) return true; // marker has no parseable numeric core at all: genuinely malformed, normalize
  const core = parsed[1]!;
  const hadSuffix = parsed[2] !== undefined; // marker itself was a prerelease/build-tagged variant
  const cmp = compareVersionStrings(runningVersion, core); // safe: both sides are plain x.y.z here
  if (cmp > 0) return true; // running strictly newer than the marker's core: refresh
  if (cmp < 0) return false; // running strictly older than the marker's core: never refresh
  if (hadSuffix) return true; // same core: a prerelease marker finalizing to this exact release
  if (content === undefined || content.bundled === null) return false; // no content known: the version alone decides
  return content.installed !== content.bundled; // same version: the copy follows the bundle's content
}

/**
 * True when the skill dir exists AND the marker is stale or missing. With the
 * bundle's fingerprint (ISS-1302), a same-version copy written from another
 * bundle is stale too; without it the version alone decides.
 */
export function isSkillStale(
  runningVersion: string,
  target: SkillInstallTarget = "claude",
  bundledFingerprint?: string | null,
): boolean {
  if (!runningVersion || runningVersion === "0.0.0-dev") return false;
  if (!existsSync(join(skillDir(target), "SKILL.md"))) return false; // no skill dir = not stale, just uninstalled
  const marker = readSkillMarker(target);
  if (bundledFingerprint === undefined) return shouldRefresh(runningVersion, marker);
  return shouldRefresh(runningVersion, marker, { installed: readSkillFingerprint(target), bundled: bundledFingerprint });
}

/** ISS-1302: the running bundle's fingerprint, or null when it cannot be resolved or read. */
async function bundledSkillFingerprint(): Promise<string | null> {
  try {
    const { resolveSkillSourceDir } = await import("../cli/commands/setup-skill.js");
    return skillSourceFingerprint(resolveSkillSourceDir());
  } catch {
    return null;
  }
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
/**
 * T-507 pen hold 1, second half: the Mods copy follows the binary even when
 * the storybloq version has not changed (an nvm switch at the same version
 * leaves the marker current and the stale branch above never runs). Where a
 * copy is installed, the path it records is compared with a fresh
 * resolution on every invocation the marker check runs; the copy is
 * rewritten once when they differ and left alone when they match. A copy
 * from before the sidecar existed is rewritten once to gain it. Best-effort,
 * logged, never blocking.
 */
/**
 * ISS-1233: the settings switch follows the Mods copy.
 *
 * An upgrade that is only `npm install -g @storybloq/storybloq@latest` never
 * reaches `storybloq setup`, so this refresh is all an existing install gets,
 * and a Mods copy the client is not allowed to load draws nothing. Same rule
 * as the installer's: a value already in the file is the user's and is never
 * rewritten, so a dashboard someone turned off stays off across every
 * upgrade. Best-effort and quiet unless it actually wrote.
 *
 * Imported dynamically like every other reach into `setup-skill` from here,
 * which is also what keeps the two modules' mutual references out of the
 * static graph.
 */
async function ensureFunctionHooksSwitch(): Promise<void> {
  try {
    const { enableFunctionHooksEnv, FUNCTION_HOOKS_ENV_KEY } = await import("../cli/commands/setup-skill.js");
    if ((await enableFunctionHooksEnv()) !== "set") return;
    process.stderr.write(
      `storybloq: set env.${FUNCTION_HOOKS_ENV_KEY}=1 in ${join(homedir(), ".claude", "settings.json")} (draws the ledger dashboard)\n`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`storybloq: could not set the function-hooks switch (non-fatal): ${msg}\n`);
  }
}

async function refreshModsIfBinMoved(): Promise<void> {
  try {
    const { installMods, modsInstalled, readModsBin, MODS_DISPLAY_PATH } = await import("./mods-install.js");
    if (!modsInstalled()) return;
    const { resolveStorybloqBin } = await import("../cli/commands/setup-skill.js");
    const bin = resolveStorybloqBin();
    const recorded = readModsBin();
    if (recorded !== undefined && recorded === bin) return;
    // Same shape as the version-advance branch: the copy is on disk either
    // way, so the switch is not conditional on this re-copy succeeding.
    try {
      await installMods({ bin });
      process.stderr.write(
        `storybloq: the storybloq binary moved; refreshed Mods at ${MODS_DISPLAY_PATH} (storybloq at ${bin ?? "the bare name, not found on PATH"})\n`,
      );
    } catch (copyErr: unknown) {
      const copyMsg = copyErr instanceof Error ? copyErr.message : String(copyErr);
      process.stderr.write(
        `storybloq: Mods refresh failed (non-fatal): ${copyMsg}\n` +
        `  Run 'storybloq setup --client claude' manually to retry.\n`,
      );
    }
    await ensureFunctionHooksSwitch();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `storybloq: Mods refresh failed (non-fatal): ${msg}\n` +
      `  Run 'storybloq setup --client claude' manually to retry.\n`,
    );
  }
}

export async function autoRefreshSkillIfStale(
  runningVersion: string,
  opts: { reconcileLimitHooks?: boolean } = {},
): Promise<boolean> {
  // Default true for ordinary upgrades; a `setup --skip-hooks` invocation
  // passes false so the version refresh does not install hooks the user
  // explicitly opted out of. (The name predates T-534; it now gates only the
  // session-intel reconcile.)
  const reconcileLimitHooks = opts.reconcileLimitHooks !== false;
  // ISS-1302: the bundle is fingerprinted once per invocation, and only when
  // a copy is installed for it to be compared with.
  const installed = skillTargets().some((target) => existsSync(join(target.dir, "SKILL.md")));
  const bundled = installed ? await bundledSkillFingerprint() : null;
  const staleTargets = skillTargets().filter((target) => isSkillStale(runningVersion, target.id, bundled));
  if (staleTargets.length === 0) {
    await refreshModsIfBinMoved();
    return false;
  }

  try {
    const { copyDirRecursive, resolveSkillSourceDir, resolveStorybloqBin } =
      await import("../cli/commands/setup-skill.js");
    const src = resolveSkillSourceDir();
    let refreshedClaude = false;
    let refreshedCodex = false;

    for (const target of staleTargets) {
      // Stale only by content: the version alone would have left it alone.
      const sameVersion = !isSkillStale(runningVersion, target.id);
      await copyDirRecursive(src, target.dir);
      writeSkillMarker(runningVersion, target.id, bundled);
      refreshedClaude = refreshedClaude || target.client === "claude";
      refreshedCodex = refreshedCodex || target.client === "codex";
      process.stderr.write(
        `storybloq: refreshed skill files at ${target.displayPath} to match CLI v${runningVersion}${sameVersion ? " (same version, bundled skill changed)" : ""}\n`,
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

    // T-507 commit D: the Mods copy follows the CLI. Re-resolving the global
    // binary here is what moves the generated hooks/install.ts when the
    // binary moves (an nvm switch). Only where a copy is installed: the
    // refresh is not a setup. Best-effort, logged, never blocking.
    if (refreshedClaude) {
      try {
        const { installMods, modsInstalled, MODS_DISPLAY_PATH } = await import("./mods-install.js");
        if (modsInstalled()) {
          // ISS-1233: the switch follows the copy EXISTING, not this refresh
          // succeeding, so its own try. A copy already on disk is loadable
          // whether or not today's re-copy worked, and a transient failure
          // here (a held lock, a full disk) must not be what leaves someone's
          // dashboard dark for good: the next invocation would find the
          // marker current and never come back through this branch.
          try {
            await installMods({ bin });
            process.stderr.write(
              `storybloq: refreshed Mods at ${MODS_DISPLAY_PATH} (storybloq at ${bin ?? "the bare name, not found on PATH"})\n`,
            );
          } catch (copyErr: unknown) {
            const copyMsg = copyErr instanceof Error ? copyErr.message : String(copyErr);
            process.stderr.write(
              `storybloq: Mods refresh failed (non-fatal): ${copyMsg}\n` +
              `  Run 'storybloq setup --client claude' manually to retry.\n`,
            );
          }
          await ensureFunctionHooksSwitch();
        }
      } catch (modsErr: unknown) {
        const modsMsg = modsErr instanceof Error ? modsErr.message : String(modsErr);
        process.stderr.write(
          `storybloq: Mods refresh failed (non-fatal): ${modsMsg}\n` +
          `  Run 'storybloq setup --client claude' manually to retry.\n`,
        );
      }
    }

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

      // T-499: reconcile the session-intel hooks (not count-gated, kill-switch
      // aware, honors --skip-hooks). T-534: the limit-stop hooks are no longer
      // installed here; the retirement migration removes them.
      if (reconcileLimitHooks) {
        try {
          const { ensureSessionIntelHooksRegistered } = await import("../cli/commands/setup-skill.js");
          const intelHooks = await ensureSessionIntelHooksRegistered(undefined, bin);
          if (intelHooks.action === "installed") {
            process.stderr.write("storybloq: registered session-intel hooks on version advance\n");
          } else if (intelHooks.action === "removed") {
            process.stderr.write("storybloq: removed session-intel hooks (disabled globally)\n");
          }
        } catch (intelErr: unknown) {
          const intelMsg = intelErr instanceof Error ? intelErr.message : String(intelErr);
          process.stderr.write(
            `storybloq: session-intel hook reconcile failed (non-fatal): ${intelMsg}\n`,
          );
        }
      }
    }

    await refreshModsIfBinMoved();
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
