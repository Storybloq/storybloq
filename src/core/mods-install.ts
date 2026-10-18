/**
 * T-507 commit D: the Mods copy `storybloq setup-skill` installs for Claude
 * Code function hooks, and the version-marker refresh keeps current.
 *
 * WHAT IS COPIED. The plugin's manifest with `skills` dropped (the copy
 * carries no skill directory; /story is installed separately), the hooks
 * runtime files (every hooks/*.ts that is not a kit test, plus hooks.json),
 * and a GENERATED hooks/install.ts whose `resolveStorybloqBin()` answers the
 * absolute path of the global storybloq binary. A Mod runs under whatever
 * PATH the client has, which is not the shell's, so the bare name the
 * repository copy answers is not enough there.
 *
 * WHERE. ~/.claude/skills/storybloq/ (under CLAUDE_CONFIG_DIR when set), beside the /story skill at
 * ~/.claude/skills/story/. The client loads it with
 * `claude --plugin-dir ~/.claude/skills/storybloq` under
 * CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1; the Mod stays off until its
 * userConfig option is set.
 *
 * HOW. The whole tree is staged beside the destination (a unique mkdtemp
 * directory) and swapped in with the same atomic swap the skill copy uses
 * (`copyDirRecursive`), so a failure while staging leaves the previous copy
 * untouched and no partial copy is ever loadable. The source must carry the
 * whole runtime module graph before anything is staged: a package missing
 * one imported module would otherwise replace a working copy with one the
 * client cannot load. Installs are serialized per destination by a
 * `<dest>.lock` file taken with O_EXCL and owned by a token (a second
 * install in the same process waits on it like any other), so two setups
 * or a setup and a refresh never share the swap's fixed `.tmp` and `.bak`
 * paths. The swap itself is two renames (`dest` to `.bak`, `.tmp` to
 * `dest`), so a crash between them leaves the plugin path absent until the
 * next install runs recovery; that window is the same one the /story skill
 * copy has today, and the client loads a plugin only at session start or
 * on /reload-plugins.
 */

import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir, claudeConfigDisplay } from "./claude-config-dir.js";
import { assertNoSelfOverlap, resolveSymlinkTarget } from "./symlink-write.js";

export const MODS_DIR_NAME = "storybloq";

/** The Mods copy's directory: ~/.claude/skills/storybloq/, under CLAUDE_CONFIG_DIR when it is set (ISS-1270). */
export function modsDir(): string {
  return join(claudeConfigDir(), "skills", MODS_DIR_NAME);
}

/** modsDir() as a user reads it, so a message never names a directory the copy did not use. */
export function modsDisplayPath(): string {
  return `${claudeConfigDisplay("skills", MODS_DIR_NAME)}/`;
}

/**
 * Sidecar beside the generated install.ts recording the binary path the copy
 * answers (empty when it answers the bare name), so the version-marker check
 * can tell on every invocation whether the binary has moved without parsing
 * the generated module.
 */
export const MODS_BIN_FILE = ".storybloq-bin";

/**
 * The binary path the installed copy answers: null when it answers the bare
 * name, undefined when no sidecar exists (a copy from before the sidecar, or
 * no copy at all).
 */
export function readModsBin(dir: string = modsDir()): string | null | undefined {
  const p = join(dir, "hooks", MODS_BIN_FILE);
  if (!existsSync(p)) return undefined;
  const text = readFileSync(p, "utf-8").trim();
  return text.length > 0 ? text : null;
}

/**
 * Resolves the bundled plugin directory, in either layout:
 *   - Bundled (npm): dist/cli.js, plugin at <pkg>/plugins/storybloq
 *   - Source (dev):  src/core/mods-install.ts, plugin at <pkg>/plugins/storybloq
 */
export function resolvePluginSourceDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const bundled = join(thisDir, "..", "plugins", MODS_DIR_NAME);
  if (existsSync(join(bundled, "hooks", "mod.ts"))) return bundled;
  const source = join(thisDir, "..", "..", "plugins", MODS_DIR_NAME);
  if (existsSync(join(source, "hooks", "mod.ts"))) return source;
  throw new Error(`Cannot find the bundled plugin source. Checked:\n  ${bundled}\n  ${source}`);
}

/** True when a Mods copy is installed (its hooks module exists), so a refresh has something to refresh. */
export function modsInstalled(dir: string = modsDir()): boolean {
  return existsSync(join(dir, "hooks", "mod.ts"));
}

/**
 * The generated hooks/install.ts. A string literal, JSON-escaped, so a path
 * with a quote, a backslash or a space still parses; the bare name when no
 * global binary could be resolved at install time.
 */
export function renderInstallModule(bin: string | null): string {
  const answer = bin === null ? "storybloq" : bin;
  const how = bin === null
    ? " * No global storybloq binary could be resolved when this copy was written,\n" +
      " * so this answers the bare name and the host resolves it on its PATH. A\n" +
      " * later `storybloq setup-skill`, or the version-marker refresh, replaces it."
    : " * The absolute path of the global storybloq binary as resolved when this\n" +
      " * copy was written. The version-marker refresh re-resolves it when the\n" +
      " * binary moves (an nvm switch), so this copy follows the CLI.";
  return (
    "/**\n" +
    " * GENERATED by `storybloq setup-skill` (T-507). Do not edit: the next\n" +
    " * refresh overwrites it.\n" +
    " *\n" +
    `${how}\n` +
    " */\n" +
    "export function resolveStorybloqBin(): string {\n" +
    `  return ${JSON.stringify(answer)};\n` +
    "}\n"
  );
}

export interface InstallModsOptions {
  /** The resolved global binary, or null when none could be resolved. */
  readonly bin: string | null;
  /** The plugin directory to copy from; the bundled one by default. */
  readonly sourceDir?: string;
  /** Where to install; `modsDir()` by default. */
  readonly destDir?: string;
}

export interface InstallModsResult {
  readonly dir: string;
  readonly bin: string | null;
  /** Paths written, relative to `dir`. */
  readonly written: readonly string[];
}

/**
 * The runtime module graph the copy must carry whole: mod.ts imports
 * sidebar.ts, sidebar.ts imports sidebar-projection.ts, and client-api.ts is
 * the pin they are checked against. install.ts is generated.
 */
export const REQUIRED_HOOK_FILES = ["hooks.json", "mod.ts", "client-api.ts", "sidebar.ts", "sidebar-projection.ts", "storyfield-logo.ts"] as const;

/** How long a second installer waits for the first's lock before giving up. */
export const MODS_LOCK_WAIT_MS = 10_000;
/** A lock whose holder cannot be checked for liveness and is older than this is taken over. */
export const MODS_LOCK_STALE_MS = 60_000;

/**
 * Test seams. `beforeSwap` is awaited after the tree is staged and before it
 * is swapped in; `onLockHeld` is called each time a contender finds the lock
 * held by a live holder and is about to wait; `pidAlive` replaces the
 * liveness probe; `lockWaitMs` shortens the lock wait.
 */
export const __installModsTestHooks: {
  beforeSwap: (() => Promise<void>) | null;
  onLockHeld: (() => void) | null;
  pidAlive: ((pid: number) => boolean) | null;
  /** Shortens the lock wait so a fail-closed path can be tested in seconds. */
  lockWaitMs: number | null;
} = { beforeSwap: null, onLockHeld: null, pidAlive: null, lockWaitMs: null };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  if (__installModsTestHooks.pidAlive !== null) return __installModsTestHooks.pidAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockBody {
  readonly pid: number;
  readonly token: string;
  readonly mtimeMs: number;
}

/**
 * Reads `<pid> <token>` from a lock. Null only when the lock is gone
 * (ENOENT); a malformed body reads as pid -1 with an empty token; every
 * other failure is the caller's to see, not a reason to spin.
 */
async function readLock(lockPath: string): Promise<LockBody | null> {
  try {
    const [body, info] = await Promise.all([readFile(lockPath, "utf-8"), stat(lockPath)]);
    const m = /^(\d+) ([0-9a-f-]{36})\s*$/.exec(body);
    if (!m) return { pid: -1, token: "", mtimeMs: info.mtimeMs };
    return { pid: Number(m[1]), token: m[2]!, mtimeMs: info.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function sameLock(a: LockBody, b: LockBody): boolean {
  return a.pid === b.pid && a.token === b.token && a.mtimeMs === b.mtimeMs;
}

/** A lock whose pid is dead on this machine; one whose holder cannot be judged, by age. */
function lockDead(held: LockBody): boolean {
  return held.pid > 0 ? !pidAlive(held.pid) : Date.now() - held.mtimeMs > MODS_LOCK_STALE_MS;
}

/** Creates `path` with O_EXCL carrying `<pid> <token>`; false when it exists. */
async function createLock(path: string, token: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    await handle.writeFile(`${process.pid} ${token}\n`, "utf-8");
    await handle.close();
  } catch (err) {
    try { await handle.close(); } catch { /* already closed */ }
    await rm(path, { force: true });
    throw err;
  }
  return true;
}

/** Removes `path` while it still carries `token`; a successor's lock is left alone. */
async function releaseLock(path: string, token: string): Promise<void> {
  const held = await readLock(path);
  if (held !== null && held.token === token) await rm(path, { force: true });
}

/**
 * Reclaims a dead `<dir>.lock` under `<dir>.lock.reclaim`, a second O_EXCL
 * lock that serializes reclaims: the main lock is re-read while the reclaim
 * lock is held and removed only if it is still the lock that was judged
 * dead, so a contender can never remove a fresh lock a rival took after
 * reclaiming ahead of it. A reclaim lock that is not ours is NEVER removed
 * here, whatever its body says: a live reclaimer releases it within a few
 * file operations, so the caller waits for it up to the deadline and then
 * fails closed naming the path. Automatic removal of an abandoned reclaim
 * lock would let two reclaimers into this section (both read it, one
 * removes and retakes it, the other's pending removal deletes the fresh
 * one), and a delayed removal could then take a fresh installer's main lock.
 */
async function reclaimDeadLock(lockPath: string, judgedDead: LockBody, token: string): Promise<void> {
  const reclaimPath = `${lockPath}.reclaim`;
  if (!(await createLock(reclaimPath, token))) {
    if (__installModsTestHooks.onLockHeld !== null) __installModsTestHooks.onLockHeld();
    await sleep(50);
    return; // the caller loops and looks at both locks again
  }
  try {
    const now = await readLock(lockPath);
    if (now !== null && sameLock(now, judgedDead)) await rm(lockPath, { force: true });
  } finally {
    await releaseLock(reclaimPath, token);
  }
}

/**
 * Takes `<dir>.lock` with O_EXCL. The lock carries `<pid> <token>`; release
 * removes it only while it still carries this holder's token, so a holder can
 * never remove a successor's lock. A lock whose pid is dead on this machine is
 * reclaimed at once; one whose holder cannot be judged (a malformed body) is
 * reclaimed by age; a live holder is waited for up to MODS_LOCK_WAIT_MS.
 */
async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const lockPath = `${dir}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + (__installModsTestHooks.lockWaitMs ?? MODS_LOCK_WAIT_MS);
  for (;;) {
    if (Date.now() >= deadline) {
      const reclaimPath = `${lockPath}.reclaim`;
      if (existsSync(reclaimPath)) {
        throw new Error(
          `a storybloq install lock is left at ${reclaimPath} and was not released; delete that file and run the install again`,
        );
      }
      throw new Error(`another storybloq install holds ${lockPath}; try again in a moment`);
    }
    if (await createLock(lockPath, token)) {
      return () => releaseLock(lockPath, token);
    }
    const held = await readLock(lockPath);
    if (held === null) continue; // released between the open and the read
    if (lockDead(held)) {
      await reclaimDeadLock(lockPath, held, token);
      continue;
    }
    if (__installModsTestHooks.onLockHeld !== null) __installModsTestHooks.onLockHeld();
    await sleep(50);
  }
}

/**
 * Installs (or replaces) the Mods copy. Stages the whole tree beside the
 * destination, then swaps it in atomically; throws before touching the
 * destination when the source is missing or incomplete.
 */
export async function installMods(options: InstallModsOptions): Promise<InstallModsResult> {
  const dir = options.destDir ?? modsDir();
  const sourceDir = options.sourceDir ?? resolvePluginSourceDir();
  const manifestPath = join(sourceDir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath) || !existsSync(join(sourceDir, "hooks"))) {
    throw new Error(`Mods plugin source not found at ${sourceDir}`);
  }
  for (const name of REQUIRED_HOOK_FILES) {
    if (!existsSync(join(sourceDir, "hooks", name))) {
      throw new Error(`Mods plugin source at ${sourceDir} is incomplete: hooks/${name} is missing`);
    }
  }

  // ISS-1234: the swap below follows a symlinked destination and compares
  // the STAGE against it, which never overlaps; the source is what must not.
  let destTarget = dir;
  try {
    if ((await lstat(dir)).isSymbolicLink()) destTarget = await resolveSymlinkTarget(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await assertNoSelfOverlap(sourceDir, dir, destTarget);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  delete manifest["skills"];

  const runtimeFiles = (await readdir(join(sourceDir, "hooks")))
    .filter((name) => (name.endsWith(".ts") && !name.endsWith(".test.ts")) || name === "hooks.json")
    .filter((name) => name !== "install.ts")
    .sort();

  await mkdir(dirname(dir), { recursive: true });
  const release = await acquireLock(dir);
  let stage: string | null = null;
  const written: string[] = [];
  try {
    stage = await mkdtemp(`${dir}.stage-`);
    await mkdir(join(stage, ".claude-plugin"), { recursive: true });
    await mkdir(join(stage, "hooks"), { recursive: true });
    await writeFile(join(stage, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    written.push(".claude-plugin/plugin.json");
    for (const name of runtimeFiles) {
      await writeFile(join(stage, "hooks", name), await readFile(join(sourceDir, "hooks", name)));
      written.push(`hooks/${name}`);
    }
    await writeFile(join(stage, "hooks", "install.ts"), renderInstallModule(options.bin), "utf-8");
    written.push("hooks/install.ts");
    await writeFile(join(stage, "hooks", MODS_BIN_FILE), `${options.bin ?? ""}\n`, "utf-8");
    written.push(`hooks/${MODS_BIN_FILE}`);

    if (__installModsTestHooks.beforeSwap !== null) await __installModsTestHooks.beforeSwap();
    const { copyDirRecursive } = await import("../cli/commands/setup-skill.js");
    await copyDirRecursive(stage, dir);
  } finally {
    try {
      if (stage !== null) await rm(stage, { recursive: true, force: true });
    } finally {
      await release();
    }
  }
  return { dir, bin: options.bin, written };
}
