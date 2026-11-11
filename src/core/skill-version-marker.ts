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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, realpathSync, lstatSync, statSync, accessSync, constants as fsConstants, openSync, readSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { delimiter as pathDelimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { compareVersionStrings } from "./team-capabilities.js";
import { readBoundedFile } from "./bounded-read.js";
import { sanitizeDisplayPath } from "./display-text.js";
import { claudeConfigDir, claudeConfigDisplay, claudeSettingsPath } from "./claude-config-dir.js";
import { storybloqGlobalDir } from "./global-config.js";

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
        dir: join(claudeConfigDir(), "skills", "story"),
        displayPath: `${claudeConfigDisplay("skills", "story")}/`,
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
      `storybloq: set env.${FUNCTION_HOOKS_ENV_KEY}=1 in ${claudeSettingsPath()} (draws the ledger dashboard)\n`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`storybloq: could not set the function-hooks switch (non-fatal): ${msg}\n`);
  }
}

/**
 * ISS-1323: whether the running CLI is the operator's global install. Only
 * the package `npm root -g` names as @storybloq/storybloq ("owner") may
 * rewrite the global skill copies and the Mods on its own. Another package
 * (a clone's dist/cli.js, a local devDependency, an npx copy) is "foreign";
 * when either side cannot be established the verdict is "unknown". Both skip
 * the automatic write: `storybloq setup` is the deliberate way to install a
 * non-global CLI's skill.
 */
export type RefreshOwnership = "owner" | "foreign" | "unknown";

export interface RefreshOwnershipResult {
  readonly verdict: RefreshOwnership;
  readonly runningRoot: string | null;
  readonly globalRoot: string | null;
}

/**
 * Test seam and per-process memo for the verdict. It spawns npm, so it is
 * computed only when a write is pending, and at most once per process.
 * ISS-1493: `cache` is the disk entry that matches this process's key, once
 * the verdict has been read from or written to it; the notice gate uses it.
 */
export const refreshOwner: {
  override: (() => RefreshOwnership) | null;
  memo: { value: RefreshOwnershipResult } | null;
  noticed: boolean;
  cache: OwnershipCacheEntry | null;
  /** Test seam (ISS-1493 N3): runs after ownership is resolved and before the entry is persisted. */
  beforePersist: (() => void) | null;
} = { override: null, memo: null, noticed: false, cache: null, beforePersist: null };

/**
 * ISS-1493: the verdict remembered across processes. Without it every CLI
 * call with a stale or unmarked skill copy spawned `npm root -g` (and npm
 * wrote a log under HOME/.npm) and printed the notice again. The entry is
 * valid only while everything the verdict was computed from is unchanged:
 * the running package, the inputs that decide npm's prefix, the global
 * package npm named, and the marker state of every skill target. Each of
 * those is read with no spawn. There is no expiry; any change is a miss.
 */
export const OWNERSHIP_CACHE_FILE = "refresh-ownership.json";
const OWNERSHIP_CACHE_MAX_BYTES = 16_384;

/** The parts of the key computed fresh on every read (no spawn). */
export interface OwnershipLocalKey {
  readonly runningRoot: string;
  readonly execPath: string | null;
  readonly prefixEnv: readonly (string | null)[];
  /** Realpath of the first npm on PATH (found without a spawn). */
  readonly npm: string;
  /** Realpath of the node npm's shebang runs (ISS-1493 O2). */
  readonly node: string;
  /** npm_config_userconfig, NPM_CONFIG_USERCONFIG, npm_config_globalconfig, NPM_CONFIG_GLOBALCONFIG. */
  readonly configEnv: readonly (string | null)[];
  /** Hash of the user npmrc that applies, and of the global npmrc ("absent" when the file does not exist). */
  readonly userconfig: string;
  readonly globalconfig: string;
  readonly skills: readonly { readonly dir: string; readonly skill: boolean; readonly marker: string | null; readonly fingerprint: string | null }[];
}

export interface OwnershipCacheEntry {
  readonly version: 1;
  readonly local: OwnershipLocalKey;
  /** What `npm root -g` answered when the verdict was computed. */
  readonly npmRoot: string;
  /** The identity of the global package npm named, at that time ("absent" when none). */
  readonly globalPackage: string;
  readonly verdict: RefreshOwnership;
  readonly runningRoot: string | null;
  readonly globalRoot: string | null;
  readonly noticed: boolean;
}

export function ownershipCachePath(): string {
  return join(storybloqGlobalDir(), OWNERSHIP_CACHE_FILE);
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

const NPM_CONFIG_MAX_BYTES = 65_536;

/**
 * ISS-1493 N2: "absent" only when the file does not exist. An existing file
 * that cannot be read, is not a regular file, or is over the bound returns
 * null, which disables the cache: its content is unknown, not empty.
 */
function configFileHash(p: string): string | null {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > NPM_CONFIG_MAX_BYTES) return null;
    const body = readFileSync(p);
    if (body.length > NPM_CONFIG_MAX_BYTES) return null;
    // ISS-1493 O1: a file that itself sets prefix or globalconfig moves what
    // npm reads; that resolution is npm's, so the cache is bypassed.
    if (setsNpmLocationKey(body.toString("utf-8"))) return null;
    return `sha256:${createHash("sha256").update(body).digest("hex")}`;
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : null;
  }
}

/** ISS-1493 O1: true when any ini line's key, trimmed and case-insensitive, is prefix or globalconfig (any value). */
function setsNpmLocationKey(body: string): boolean {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = (eq === -1 ? line : line.slice(0, eq)).trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (key === "prefix" || key === "globalconfig") return true;
  }
  return false;
}

/** ISS-1493 N1: the realpath of the first executable `npm` on PATH, by walking PATH (no spawn). */
function npmOnPath(): string | null {
  return onPath(process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"]);
}

/**
 * ISS-1493 O2: the node npm runs under, from npm's own shebang (bounded
 * read). `#!/usr/bin/env node` resolves node by the same PATH walk; an
 * absolute node path is used as is. Anything else (another interpreter, a
 * shell shim, Windows) is not simple enough to key on: null.
 */
function npmInterpreter(npm: string): string | null {
  if (process.platform === "win32") return null;
  let head: string;
  try {
    const fd = openSync(npm, "r");
    try {
      const buf = Buffer.alloc(256);
      head = buf.subarray(0, readSync(fd, buf, 0, 256, 0)).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const first = (head.split("\n")[0] ?? "").replace(/\r$/, "");
  if (!first.startsWith("#!")) return null;
  const [cmd = "", arg, ...rest] = first.slice(2).trim().split(/\s+/);
  if (cmd === "/usr/bin/env" && arg === "node" && rest.length === 0) return onPath(["node"]);
  if (arg === undefined && cmd.startsWith("/") && cmd.split("/").pop() === "node") return realpathOrNull(cmd);
  return null;
}

/** The realpath of the first executable regular file named one of `names` on PATH (no spawn). */
function onPath(names: readonly string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(pathDelimiter);
  // ISS-1493 P1: an empty or relative component is the current directory to
  // a real lookup; the answer then depends on cwd, so the cache is bypassed.
  if (dirs.some((d) => d === "" || !isAbsolute(d))) return null;
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, fsConstants.X_OK);
        return realpathSync(candidate);
      } catch {
        // not this one
      }
    }
  }
  return null;
}

/** Key parts a, b and d of the plan: running root, npm prefix inputs, skill marker state. Null when the running root cannot be resolved. */
export async function ownershipLocalKey(): Promise<OwnershipLocalKey | null> {
  try {
    const { resolveSkillSourceDir } = await import("../cli/commands/setup-skill.js");
    const runningRoot = realpathSync(resolve(resolveSkillSourceDir(), "..", ".."));
    // ISS-1493 N1: every input npm reads to answer `root -g`; any one that
    // cannot be determined bypasses the cache (no read, no write).
    const npm = npmOnPath();
    if (npm === null) return null;
    const node = npmInterpreter(npm);
    if (node === null) return null;
    const env = (k: string): string | null => process.env[k] || null;
    const configEnv = ["npm_config_userconfig", "NPM_CONFIG_USERCONFIG", "npm_config_globalconfig", "NPM_CONFIG_GLOBALCONFIG"].map(env);
    const userconfig = configFileHash(configEnv[0] ?? configEnv[1] ?? join(homedir(), ".npmrc"));
    // npm's default global npmrc is <prefix>/etc/npmrc, the prefix being the
    // configured one or else that of the node npm runs under (bin/node -> two levels up).
    const prefix = env("npm_config_prefix") ?? env("NPM_CONFIG_PREFIX") ?? env("PREFIX") ?? dirname(dirname(node));
    const globalconfig = configFileHash(configEnv[2] ?? configEnv[3] ?? join(prefix, "etc", "npmrc"));
    if (userconfig === null || globalconfig === null) return null;
    return {
      runningRoot,
      execPath: realpathOrNull(process.execPath),
      prefixEnv: ["npm_config_prefix", "NPM_CONFIG_PREFIX", "PREFIX"].map((k) => process.env[k] ?? null),
      npm,
      node,
      configEnv,
      userconfig,
      globalconfig,
      skills: skillTargets().map((t) => ({
        dir: t.dir,
        skill: existsSync(join(t.dir, "SKILL.md")),
        marker: readSkillMarker(t.id),
        fingerprint: readSkillFingerprint(t.id),
      })),
    };
  } catch {
    return null;
  }
}

/** Key part c: the global package's package.json as it is now, by realpath and stat identity. */
export function globalPackageIdentity(npmRoot: string): string {
  const pkgDir = join(npmRoot, "@storybloq", "storybloq");
  try {
    const st = lstatSync(join(pkgDir, "package.json"));
    return `${realpathOrNull(pkgDir) ?? "?"}|${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "absent";
  }
}

const strOrNull = (x: unknown): boolean => x === null || typeof x === "string";

/** ISS-1493 N4: the full local key shape, every field. */
function isLocalKey(v: unknown): v is OwnershipLocalKey {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  return typeof k.runningRoot === "string" && strOrNull(k.execPath) && typeof k.npm === "string" && typeof k.node === "string" &&
    Array.isArray(k.prefixEnv) && k.prefixEnv.length === 3 && k.prefixEnv.every(strOrNull) &&
    Array.isArray(k.configEnv) && k.configEnv.length === 4 && k.configEnv.every(strOrNull) &&
    typeof k.userconfig === "string" && typeof k.globalconfig === "string" &&
    Array.isArray(k.skills) && k.skills.every((x: unknown) => {
      if (typeof x !== "object" || x === null) return false;
      const t = x as Record<string, unknown>;
      return typeof t.dir === "string" && typeof t.skill === "boolean" && strOrNull(t.marker) && strOrNull(t.fingerprint);
    });
}

function isEntry(v: unknown): v is OwnershipCacheEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return e.version === 1 && isLocalKey(e.local) && typeof e.npmRoot === "string" &&
    typeof e.globalPackage === "string" && (e.verdict === "owner" || e.verdict === "foreign" || e.verdict === "unknown") &&
    (e.runningRoot === null || typeof e.runningRoot === "string") && (e.globalRoot === null || typeof e.globalRoot === "string") &&
    typeof e.noticed === "boolean";
}

/** The entry on disk, or null for anything but a regular, bounded, well-shaped file. */
export function readOwnershipCache(): OwnershipCacheEntry | null {
  const p = ownershipCachePath();
  try {
    if (!lstatSync(p).isFile()) return null;
    const body = readBoundedFile(p, OWNERSHIP_CACHE_MAX_BYTES);
    if (body === null) return null;
    const parsed: unknown = JSON.parse(body);
    return isEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write-then-rename (the update-check.ts pattern, mirrored here): a failed
 * write leaves the previous entry intact, and the rename replaces a symlink
 * at the path instead of writing through it. Best-effort and silent.
 */
function writeOwnershipCache(entry: OwnershipCacheEntry): boolean {
  const p = ownershipCachePath();
  let owned: { path: string; fd: number } | null = null;
  try {
    mkdirSync(storybloqGlobalDir(), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${randomBytes(2).toString("hex")}`;
    const fd = openSync(tmp, "wx", 0o600);
    owned = { path: tmp, fd };
    writeFileSync(fd, `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
    closeSync(fd);
    owned = { path: tmp, fd: -1 };
    renameSync(tmp, p);
    owned = null;
    return true;
  } catch {
    return false;
  } finally {
    if (owned !== null) {
      if (owned.fd >= 0) {
        try { closeSync(owned.fd); } catch { /* ignore */ }
      }
      try { unlinkSync(owned.path); } catch { /* ignore */ }
    }
  }
}

function sameKey(a: OwnershipLocalKey, b: OwnershipLocalKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const PACKAGE_NAME = "@storybloq/storybloq";

function storybloqPackageRoot(dir: string): string | null {
  const real = realpathSync(dir);
  const pkg = JSON.parse(readFileSync(join(real, "package.json"), "utf-8")) as { name?: unknown };
  return pkg.name === PACKAGE_NAME ? real : null;
}

/** The verdict, plus what npm answered (null when npm itself failed, which is never cached). */
async function computeRefreshOwnership(): Promise<{ readonly result: RefreshOwnershipResult; readonly npmRoot: string | null; readonly identityBefore: string | null }> {
  let runningRoot: string | null = null;
  let globalRoot: string | null = null;
  let npmRoot: string | null = null;
  try {
    const { resolveSkillSourceDir, npmGlobalRoot } = await import("../cli/commands/setup-skill.js");
    // <pkg>/src/skill in both the dist and the source layout.
    runningRoot = realpathSync(resolve(resolveSkillSourceDir(), "..", ".."));
    npmRoot = npmGlobalRoot();
    if (npmRoot === null) return { result: { verdict: "unknown", runningRoot, globalRoot }, npmRoot, identityBefore: null };
    const identityBefore = globalPackageIdentity(npmRoot);
    // A package that is absent or not ours is an answer npm gave: cacheable.
    try {
      globalRoot = storybloqPackageRoot(join(npmRoot, "@storybloq", "storybloq"));
    } catch {
      globalRoot = null;
    }
    if (globalRoot === null) return { result: { verdict: "unknown", runningRoot, globalRoot }, npmRoot, identityBefore };
    const same = process.platform === "win32"
      ? globalRoot.toLowerCase() === runningRoot.toLowerCase()
      : globalRoot === runningRoot;
    return { result: { verdict: same ? "owner" : "foreign", runningRoot, globalRoot }, npmRoot, identityBefore };
  } catch {
    return { result: { verdict: "unknown", runningRoot, globalRoot }, npmRoot: null, identityBefore: null };
  }
}

/** ISS-1493: the disk entry when it still matches, else the computation (one npm spawn), remembered when npm answered. */
async function cachedOrComputedOwnership(): Promise<RefreshOwnershipResult> {
  const local = await ownershipLocalKey();
  if (local !== null) {
    const entry = readOwnershipCache();
    if (entry !== null && sameKey(entry.local, local) && globalPackageIdentity(entry.npmRoot) === entry.globalPackage) {
      refreshOwner.cache = entry;
      return { verdict: entry.verdict, runningRoot: entry.runningRoot, globalRoot: entry.globalRoot };
    }
  }
  const { result, npmRoot, identityBefore } = await computeRefreshOwnership();
  refreshOwner.beforePersist?.();
  // ISS-1493 N3: persist only when the global package is the one the verdict
  // was read from: identity taken before reading ownership and again now.
  if (local !== null && npmRoot !== null && identityBefore !== null && globalPackageIdentity(npmRoot) === identityBefore) {
    const entry: OwnershipCacheEntry = {
      version: 1, local, npmRoot, globalPackage: identityBefore,
      verdict: result.verdict, runningRoot: result.runningRoot, globalRoot: result.globalRoot, noticed: false,
    };
    if (writeOwnershipCache(entry)) refreshOwner.cache = entry;
  }
  return result;
}

/** The memoised verdict (the override, when a test set one). */
export async function refreshOwnershipVerdict(): Promise<RefreshOwnershipResult> {
  if (refreshOwner.override) return { verdict: refreshOwner.override(), runningRoot: null, globalRoot: null };
  if (refreshOwner.memo === null) refreshOwner.memo = { value: await cachedOrComputedOwnership() };
  return refreshOwner.memo.value;
}

/** The memoised verdict, for callers that already hold it; null before the first computation. */
export function refreshOwnership(): RefreshOwnershipResult | null {
  if (refreshOwner.override) return { verdict: refreshOwner.override(), runningRoot: null, globalRoot: null };
  return refreshOwner.memo?.value ?? null;
}

/**
 * True when this process may write. Otherwise prints the one notice and
 * returns false: once per process, and (ISS-1493) once per cached state, so a
 * later process in the same state stays quiet.
 */
async function mayAutoRefresh(): Promise<boolean> {
  const { verdict, runningRoot, globalRoot } = await refreshOwnershipVerdict();
  if (verdict === "owner") return true;
  if (!refreshOwner.noticed) {
    refreshOwner.noticed = true;
    const cached = refreshOwner.cache;
    if (cached !== null && cached.noticed) return false;
    if (cached !== null) {
      const marked: OwnershipCacheEntry = { ...cached, noticed: true };
      if (writeOwnershipCache(marked)) refreshOwner.cache = marked;
    }
    const running = runningRoot === null ? "unknown location" : sanitizeDisplayPath(runningRoot);
    const global = globalRoot === null ? "not found" : sanitizeDisplayPath(globalRoot);
    process.stderr.write(
      `storybloq: skill files not refreshed: this storybloq (${running}) is not the global install (${global}); ` +
      `run 'storybloq setup' to install its skill on purpose\n`,
    );
  }
  return false;
}

async function refreshModsIfBinMoved(): Promise<void> {
  try {
    const { installMods, modsInstalled, readModsBin, modsDisplayPath } = await import("./mods-install.js");
    if (!modsInstalled()) return;
    const { resolveStorybloqBin } = await import("../cli/commands/setup-skill.js");
    const bin = resolveStorybloqBin();
    const recorded = readModsBin();
    if (recorded !== undefined && recorded === bin) return;
    // ISS-1323: the reinstall copies the running package's Mods.
    if (!(await mayAutoRefresh())) return;
    // Same shape as the version-advance branch: the copy is on disk either
    // way, so the switch is not conditional on this re-copy succeeding.
    try {
      await installMods({ bin });
      process.stderr.write(
        `storybloq: the storybloq binary moved; refreshed Mods at ${modsDisplayPath()} (storybloq at ${bin ?? "the bare name, not found on PATH"})\n`,
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
  opts: { reconcileHooks?: boolean } = {},
): Promise<boolean> {
  // Default true for ordinary upgrades; a `setup --skip-hooks` invocation
  // passes false so the version refresh does not install hooks the user
  // explicitly opted out of. It gates the session-intel reconcile.
  const reconcileHooks = opts.reconcileHooks !== false;
  // ISS-1302: the bundle is fingerprinted once per invocation, and only when
  // a copy is installed for it to be compared with.
  const installed = skillTargets().some((target) => existsSync(join(target.dir, "SKILL.md")));
  const bundled = installed ? await bundledSkillFingerprint() : null;
  const staleTargets = skillTargets().filter((target) => isSkillStale(runningVersion, target.id, bundled));
  if (staleTargets.length === 0) {
    await refreshModsIfBinMoved();
    return false;
  }
  // ISS-1323: every write below copies from the running package.
  if (!(await mayAutoRefresh())) return false;

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
        const { installMods, modsInstalled, modsDisplayPath } = await import("./mods-install.js");
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
              `storybloq: refreshed Mods at ${modsDisplayPath()} (storybloq at ${bin ?? "the bare name, not found on PATH"})\n`,
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
      if (reconcileHooks) {
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
