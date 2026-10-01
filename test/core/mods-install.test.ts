/**
 * T-507 commit D: the Mods (function hooks) copy that `storybloq setup-skill`
 * writes under ~/.claude/skills/storybloq/ and the version-marker refresh
 * keeps current.
 *
 * The copy is the plugin's manifest (with `skills` dropped: the copy carries
 * no skill directory) plus the hooks runtime files, and a GENERATED
 * hooks/install.ts whose `resolveStorybloqBin()` answers the absolute path
 * of the global storybloq binary. The client loads a Mod with a PATH the
 * shell did not set, so the bare name the repository copy answers is not
 * enough there.
 *
 * Pen hold 1 (T-507): when the global binary moves (an nvm switch), the
 * version-marker auto-refresh must re-resolve that path. M-NO-RERESOLVE
 * (the refresh copies the files but keeps the old install.ts) goes red
 * against the "moves with the binary" test below. Other mutants this file
 * kills: M-ALWAYS-INSTALL, M-KEEP-TESTS, M-KEEP-SKILLS, M-PARTIAL-GRAPH,
 * M-NO-DEAD-RECLAIM, M-NO-STALE-TAKEOVER, M-RELEASE-ANY, M-RECLAIM-AUTO, M-RECLAIM-DEAD-AUTO, M-NO-PATH-TRACK, M-RECOPY-ALWAYS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm, chmod, readdir, lstat, symlink } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_SRC = join(PKG_ROOT, "plugins", "storybloq");

/**
 * ISS-1302: a copy is current when its version marker equals the running
 * version AND its fingerprint sidecar matches the bundle it would be copied
 * from; a marker alone at the same version is a pre-sidecar copy and is
 * refreshed once.
 */
async function markSkillCurrent(home: string, version: string): Promise<void> {
  const { skillSourceFingerprint, SKILL_FINGERPRINT_FILE } = await import("../../src/core/skill-version-marker.js");
  const { resolveSkillSourceDir } = await import("../../src/cli/commands/setup-skill.js");
  const dir = join(home, ".claude", "skills", "story");
  await writeFile(join(dir, ".storybloq-version"), `${version}\n`, "utf-8");
  await writeFile(join(dir, SKILL_FINGERPRINT_FILE), `${skillSourceFingerprint(resolveSkillSourceDir())}\n`, "utf-8");
}

async function fakeBin(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const bin = join(dir, "storybloq");
  await writeFile(bin, "#!/bin/sh\n", "utf-8");
  await chmod(bin, 0o755);
  return bin;
}

/**
 * An install a test leaves running while it asserts: the rejection handler is
 * attached at creation so a failure before the test reaches `await` is never
 * an unhandled rejection, and the returned promise always settles so the
 * test's finally can wait for the install before teardown.
 */
function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => undefined, () => undefined);
}

/** Polls `cond` every 10 ms; fails after `timeoutMs` (well inside the test timeout, leaving room for cleanup) so a broken lock cannot hang the suite. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** True when this process can read `path` (as root it can, whatever the mode). */
async function readable(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Every regular file under `root`, as relative path to bytes. */
async function snapshotTree(root: string, prefix = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [k, v] of await snapshotTree(root, rel)) out.set(k, v);
    else out.set(rel, await readFile(join(root, rel), "utf-8"));
  }
  return out;
}

describe("renderInstallModule (T-507 D)", () => {
  it("answers the absolute path as a string literal, JSON-escaped", async () => {
    const { renderInstallModule } = await import("../../src/core/mods-install.js");
    const text = renderInstallModule("/Users/a b/.nvm/versions/node/v22/bin/storybloq");
    expect(text).toContain('return "/Users/a b/.nvm/versions/node/v22/bin/storybloq";');
    expect(text).toContain("export function resolveStorybloqBin(): string {");
    expect(text).not.toContain("\u2014");
  });

  it("falls back to the bare name when no binary resolved, and says so in the module", async () => {
    const { renderInstallModule } = await import("../../src/core/mods-install.js");
    const text = renderInstallModule(null);
    expect(text).toContain('return "storybloq";');
    expect(text).toMatch(/not (be )?resolved|no global/i);
  });

  it("escapes a path that carries a quote or a backslash so the module still parses and answers it", async () => {
    const { renderInstallModule } = await import("../../src/core/mods-install.js");
    const path = 'C:\\Users\\o"k\\storybloq.cmd';
    const text = renderInstallModule(path);
    expect(text).toContain(JSON.stringify(path));
    const ts = await import("typescript");
    const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    expect(out.diagnostics ?? []).toEqual([]);
    const exports: Record<string, unknown> = {};
    new Function("exports", out.outputText)(exports);
    expect((exports["resolveStorybloqBin"] as () => string)()).toBe(path);
  });
});

describe("installMods (T-507 D)", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-mods-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes the manifest without `skills`, the hooks runtime files, no test file, and the generated install.ts", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    const result = await installMods({ bin });
    const dir = modsDir();
    expect(dir).toBe(join(tempDir, ".claude", "skills", "storybloq"));
    expect(result.dir).toBe(dir);
    expect(result.bin).toBe(bin);

    const manifest = JSON.parse(await readFile(join(dir, ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    const source = JSON.parse(await readFile(join(PLUGIN_SRC, ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("skills");
    expect(manifest["hooks"]).toBe("./hooks/hooks.json");
    expect(manifest["userConfig"]).toEqual(source["userConfig"]);
    expect(manifest["version"]).toBe(source["version"]);

    const hooks = (await readdir(join(dir, "hooks"))).sort();
    const sourceHooks = (await readdir(join(PLUGIN_SRC, "hooks"))).filter((f) => !f.endsWith(".test.ts")).sort();
    // The copy is the source's runtime files plus the generated install.ts and the binary sidecar.
    expect(hooks).toEqual([".storybloq-bin", ...sourceHooks].sort());
    expect(hooks.some((f) => f.endsWith(".test.ts"))).toBe(false);
    expect((await readFile(join(dir, "hooks", ".storybloq-bin"), "utf-8")).trim()).toBe(bin);
    for (const name of hooks) {
      if (name === "install.ts" || name === ".storybloq-bin") continue;
      expect(await readFile(join(dir, "hooks", name), "utf-8")).toBe(await readFile(join(PLUGIN_SRC, "hooks", name), "utf-8"));
    }
    expect(await readFile(join(dir, "hooks", "install.ts"), "utf-8")).toContain(`return ${JSON.stringify(bin)};`);
    expect(result.written).toContain("hooks/install.ts");
    expect(result.written).toContain(".claude-plugin/plugin.json");
    expect(existsSync(join(dir, "skills"))).toBe(false);
  });

  it("leaves no staging directory behind and replaces a previous copy whole", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const first = await fakeBin(join(tempDir, "a"));
    await installMods({ bin: first });
    await writeFile(join(modsDir(), "hooks", "stray.ts"), "// left by an older version\n", "utf-8");
    const second = await fakeBin(join(tempDir, "b"));
    await installMods({ bin: second });
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toContain(`return ${JSON.stringify(second)};`);
    expect(existsSync(join(modsDir(), "hooks", "stray.ts"))).toBe(false);
    const siblings = await readdir(join(tempDir, ".claude", "skills"));
    expect(siblings).toEqual(["storybloq"]);
  });

  it("with no binary resolved (empty PATH) still installs, answering the bare name", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const result = await installMods({ bin: null });
    expect(result.bin).toBeNull();
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toContain('return "storybloq";');
  });

  it("a missing plugin source is an error, and a previous copy is left untouched (partial failure)", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await installMods({ bin });
    const before = await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8");
    await expect(installMods({ bin: "/elsewhere/storybloq", sourceDir: join(tempDir, "no-such-plugin") })).rejects.toThrow(/plugin source|not found/i);
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toBe(before);
    expect(await readdir(join(tempDir, ".claude", "skills"))).toEqual(["storybloq"]);
  });

  it("two installs at once against the same destination both land, and leave one copy and no sibling", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const a = await fakeBin(join(tempDir, "a"));
    const b = await fakeBin(join(tempDir, "b"));
    const [first, second] = await Promise.all([installMods({ bin: a }), installMods({ bin: b })]);
    expect(first.dir).toBe(modsDir());
    expect(second.dir).toBe(modsDir());
    const installTs = await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8");
    // Whichever took the lock last wins, whole: the copy is one call's, never a mix.
    expect([`return ${JSON.stringify(a)};`, `return ${JSON.stringify(b)};`].some((line) => installTs.includes(line))).toBe(true);
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(true);
    expect(await readdir(join(tempDir, ".claude", "skills"))).toEqual(["storybloq"]);
  });

  it("a lock left by a dead process is reclaimed at once (M-NO-DEAD-RECLAIM)", async () => {
    const { installMods, modsDir, __installModsTestHooks } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await mkdir(dirname(modsDir()), { recursive: true });
    const lockPath = `${modsDir()}.lock`;
    // The liveness probe is injected: a real just-exited pid could be reused
    // by the OS between the write and the probe.
    const dead = 4_000_001;
    __installModsTestHooks.pidAlive = (pid) => pid !== dead;
    await writeFile(lockPath, `${dead} ${randomUUID()}\n`, "utf-8");
    const started = Date.now();
    try {
      await installMods({ bin });
    } finally {
      __installModsTestHooks.pidAlive = null;
    }
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(true);
  });

  it("reclaiming never removes a fresh lock a rival took after reclaiming first", async () => {
    const { installMods, modsDir, __installModsTestHooks } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await mkdir(dirname(modsDir()), { recursive: true });
    const lockPath = `${modsDir()}.lock`;
    const dead = 4_000_002;
    const rival = `${process.pid} ${randomUUID()}\n`; // alive: this process
    let swapped = false;
    let heldSeen = 0;
    // The first liveness probe answers "dead" and, as if a rival had reclaimed
    // and retaken the lock in the meantime, replaces the lock file before the
    // contender gets to remove anything. The rival must survive.
    __installModsTestHooks.pidAlive = (pid) => {
      if (pid !== dead) return true;
      if (!swapped) {
        swapped = true;
        writeFileSync(lockPath, rival, "utf-8");
      }
      return false;
    };
    __installModsTestHooks.onLockHeld = () => { heldSeen += 1; };
    let pending: Promise<unknown> | null = null;
    try {
      await writeFile(lockPath, `${dead} ${randomUUID()}\n`, "utf-8");
      pending = settle(installMods({ bin }));
      await waitFor(() => heldSeen > 0);
      expect(await readFile(lockPath, "utf-8")).toBe(rival);
      expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(false);
      await rm(lockPath, { force: true }); // the rival releases
      await pending;
    } finally {
      __installModsTestHooks.pidAlive = null;
      __installModsTestHooks.onLockHeld = null;
      await rm(lockPath, { force: true }); // never leave a test-owned lock for a still-polling install
      if (pending !== null) await pending; // nothing runs on past teardown
    }
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(true);
  }, 15_000);

  it("a reclaim lock with a dead pid is never removed: the install waits, then fails closed naming the path (M-RECLAIM-DEAD-AUTO)", async () => {
    const { installMods, modsDir, __installModsTestHooks } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await mkdir(dirname(modsDir()), { recursive: true });
    const lockPath = `${modsDir()}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    const dead = 4_000_003;
    __installModsTestHooks.pidAlive = (pid) => pid !== dead;
    __installModsTestHooks.lockWaitMs = 500;
    let heldSeen = 0;
    __installModsTestHooks.onLockHeld = () => { heldSeen += 1; };
    await writeFile(lockPath, `${dead} ${randomUUID()}\n`, "utf-8");
    await writeFile(reclaimPath, `${dead} ${randomUUID()}\n`, "utf-8");
    const started = Date.now();
    try {
      await expect(installMods({ bin })).rejects.toThrow(reclaimPath);
    } finally {
      __installModsTestHooks.pidAlive = null;
      __installModsTestHooks.lockWaitMs = null;
      __installModsTestHooks.onLockHeld = null;
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(450); // it waited for the deadline
    expect(heldSeen).toBeGreaterThan(0); // and kept looking at the reclaim lock while waiting
    expect(existsSync(reclaimPath)).toBe(true); // never auto-removed
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(false);
  }, 15_000);

  it("a reclaim lock released while the install waits lets the reclaim of the main lock proceed", async () => {
    const { installMods, modsDir, __installModsTestHooks } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await mkdir(dirname(modsDir()), { recursive: true });
    const lockPath = `${modsDir()}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    const dead = 4_000_005;
    __installModsTestHooks.pidAlive = (pid) => pid !== dead;
    let heldSeen = 0;
    __installModsTestHooks.onLockHeld = () => { heldSeen += 1; };
    await writeFile(lockPath, `${dead} ${randomUUID()}\n`, "utf-8");
    await writeFile(reclaimPath, `${process.pid} ${randomUUID()}\n`, "utf-8"); // a live reclaimer, not ours
    let pending: Promise<unknown> | null = null;
    try {
      pending = settle(installMods({ bin }));
      await waitFor(() => heldSeen >= 3);
      expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(false);
      await rm(reclaimPath, { force: true }); // the live reclaimer finishes
      await pending;
    } finally {
      __installModsTestHooks.pidAlive = null;
      __installModsTestHooks.onLockHeld = null;
      await rm(reclaimPath, { force: true });
      if (pending !== null) await pending;
    }
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(reclaimPath)).toBe(false);
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(true);
  }, 15_000);

  it("a stale reclaim lock whose holder cannot be judged fails closed, naming the path (M-RECLAIM-AUTO)", async () => {
    const { installMods, modsDir, MODS_LOCK_STALE_MS, __installModsTestHooks } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await mkdir(dirname(modsDir()), { recursive: true });
    const lockPath = `${modsDir()}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    const dead = 4_000_004;
    __installModsTestHooks.pidAlive = (pid) => pid !== dead;
    await writeFile(lockPath, `${dead} ${randomUUID()}\n`, "utf-8");
    await writeFile(reclaimPath, "garbage\n", "utf-8");
    const { utimes } = await import("node:fs/promises");
    const old = (Date.now() - MODS_LOCK_STALE_MS - 1000) / 1000;
    await utimes(reclaimPath, old, old);
    __installModsTestHooks.lockWaitMs = 500;
    const started = Date.now();
    try {
      await expect(installMods({ bin })).rejects.toThrow(reclaimPath);
    } finally {
      __installModsTestHooks.pidAlive = null;
      __installModsTestHooks.lockWaitMs = null;
    }
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(reclaimPath)).toBe(true); // never auto-removed
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(false);
  }, 15_000);

  it("a lock read that fails for a reason other than ENOENT is an error, not a ten-second wait", async (ctx) => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await mkdir(dirname(modsDir()), { recursive: true });
    const lockPath = `${modsDir()}.lock`;
    await writeFile(lockPath, `${process.pid} ${randomUUID()}\n`, "utf-8");
    await chmod(lockPath, 0o000);
    if (await readable(lockPath)) {
      await rm(lockPath, { force: true });
      ctx.skip(); // root, or a platform where mode 000 does not deny a read: the failure cannot be produced here
    }
    const started = Date.now();
    try {
      await expect(installMods({ bin })).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(lockPath, 0o644);
      await rm(lockPath, { force: true });
    }
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(false);
  });

  it("a lock whose holder cannot be judged is taken over by age only (M-NO-STALE-TAKEOVER)", async () => {
    const { installMods, modsDir, MODS_LOCK_STALE_MS } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await mkdir(dirname(modsDir()), { recursive: true });
    const lockPath = `${modsDir()}.lock`;
    await writeFile(lockPath, "garbage\n", "utf-8");
    const { utimes } = await import("node:fs/promises");
    const old = (Date.now() - MODS_LOCK_STALE_MS - 1000) / 1000;
    await utimes(lockPath, old, old);
    await installMods({ bin });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(true);
  });

  it("a lock held by a live process is waited for, and the install proceeds once it is released", async () => {
    const { installMods, modsDir, __installModsTestHooks } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await mkdir(dirname(modsDir()), { recursive: true });
    const lockPath = `${modsDir()}.lock`;
    await writeFile(lockPath, `${process.pid} ${randomUUID()}\n`, "utf-8"); // this process: alive, not ours
    let settled = false;
    let heldSeen = 0;
    __installModsTestHooks.onLockHeld = () => { heldSeen += 1; };
    let pending: Promise<unknown> | null = null;
    try {
      pending = settle(installMods({ bin }).then(() => { settled = true; }));
      await waitFor(() => heldSeen >= 3); // reached the held lock and kept waiting
      expect(settled).toBe(false);
      expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(false);
      await rm(lockPath, { force: true });
      await pending;
    } finally {
      __installModsTestHooks.onLockHeld = null;
      await rm(lockPath, { force: true });
      if (pending !== null) await pending;
    }
    expect(settled).toBe(true);
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(true);
  }, 15_000);

  it("a second install in this process waits for the first, even while the first holds the lock past the swap", async () => {
    const { installMods, modsDir, __installModsTestHooks } = await import("../../src/core/mods-install.js");
    const a = await fakeBin(join(tempDir, "a"));
    const b = await fakeBin(join(tempDir, "b"));
    let releaseFirst: (() => void) | null = null;
    let enteredFirst: () => void = () => {};
    const firstPaused = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const order: string[] = [];
    let heldSeen = 0;
    __installModsTestHooks.beforeSwap = () => {
      enteredFirst();
      return new Promise<void>((resolve) => { releaseFirst = resolve; });
    };
    __installModsTestHooks.onLockHeld = () => { heldSeen += 1; };
    const running: Promise<unknown>[] = [];
    try {
      const first = installMods({ bin: a }).then(() => order.push("first"));
      running.push(settle(first));
      // The first is staged and holding the lock; if it rejects before the
      // pause, that rejection surfaces here instead of a hang.
      await Promise.race([firstPaused, first]);
      __installModsTestHooks.beforeSwap = null; // only the first install pauses
      const second = installMods({ bin: b }).then(() => order.push("second"));
      running.push(settle(second));
      await waitFor(() => heldSeen >= 3); // the second reached the held lock and is waiting on it
      expect(order).toEqual([]); // it neither overtook nor reclaimed the first's live lock
      expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(false);
      releaseFirst!();
      await Promise.all([first, second]);
    } finally {
      __installModsTestHooks.beforeSwap = null;
      __installModsTestHooks.onLockHeld = null;
      if (releaseFirst !== null) (releaseFirst as () => void)(); // always release the pause
      await Promise.allSettled(running); // both installs are done before teardown
    }
    expect(order).toEqual(["first", "second"]);
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toContain(`return ${JSON.stringify(b)};`);
    expect(await readdir(join(tempDir, ".claude", "skills"))).toEqual(["storybloq"]);
  }, 15_000);

  it("the lock is released even when the staging directory cannot be removed", async (ctx) => {
    const { installMods, modsDir, __installModsTestHooks } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    const parent = dirname(modsDir());
    await mkdir(parent, { recursive: true });
    const lockedDirs: string[] = [];
    // Once staged, a read-only directory with a file inside is planted in the
    // stage: removing the stage then fails (the file cannot be unlinked), and
    // the lock must still be released.
    __installModsTestHooks.beforeSwap = async () => {
      for (const entry of await readdir(parent)) {
        if (!entry.startsWith("storybloq.stage-")) continue;
        const locked = join(parent, entry, "hooks", "locked");
        await mkdir(locked);
        await writeFile(join(locked, "pin"), "", "utf-8");
        await chmod(locked, 0o500);
        lockedDirs.push(locked);
      }
    };
    let rejection: unknown = null;
    try {
      rejection = await installMods({ bin }).then(() => null, (err: unknown) => err);
    } finally {
      __installModsTestHooks.beforeSwap = null;
      for (const locked of lockedDirs) {
        // Where the read-only directory did not block the removal, the stage
        // (and this directory with it) is already gone; the skip below runs.
        await chmod(locked, 0o755).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
        });
      }
    }
    expect(lockedDirs).toHaveLength(1);
    if (rejection === null) {
      // root, or a platform where a read-only directory does not block an
      // unlink: the cleanup failure cannot be produced here.
      ctx.skip();
    }
    expect(String(rejection)).toMatch(/EACCES|EPERM/);
    expect(existsSync(`${modsDir()}.lock`)).toBe(false);
    const started = Date.now();
    await installMods({ bin }); // takes the lock at once
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(true);
    for (const entry of await readdir(parent)) {
      if (entry.startsWith("storybloq.stage-")) await rm(join(parent, entry), { recursive: true, force: true });
    }
  }, 15_000);

  it("a holder's release never removes a lock a successor has since taken (M-RELEASE-ANY)", async () => {
    const { installMods, modsDir, __installModsTestHooks } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    const lockPath = `${modsDir()}.lock`;
    const successor = `${process.pid} ${randomUUID()}\n`;
    __installModsTestHooks.beforeSwap = async () => {
      // As if the lock had been reclaimed and retaken while this install ran.
      await writeFile(lockPath, successor, "utf-8");
    };
    try {
      await installMods({ bin });
    } finally {
      __installModsTestHooks.beforeSwap = null;
    }
    expect(await readFile(lockPath, "utf-8")).toBe(successor);
    await rm(lockPath, { force: true });
  });

  it("a source missing one module of the runtime graph is refused, and the previous copy stays (sidebar-projection.ts)", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await installMods({ bin });
    const before = await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8");
    const partial = join(tempDir, "partial-plugin");
    await mkdir(join(partial, ".claude-plugin"), { recursive: true });
    await mkdir(join(partial, "hooks"), { recursive: true });
    await writeFile(join(partial, ".claude-plugin", "plugin.json"), await readFile(join(PLUGIN_SRC, ".claude-plugin", "plugin.json")));
    for (const name of ["hooks.json", "mod.ts", "client-api.ts", "sidebar.ts"]) {
      await writeFile(join(partial, "hooks", name), await readFile(join(PLUGIN_SRC, "hooks", name)));
    }
    await expect(installMods({ bin: "/elsewhere/storybloq", sourceDir: partial })).rejects.toThrow(/sidebar-projection\.ts is missing/);
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toBe(before);
    expect(await readdir(join(tempDir, ".claude", "skills"))).toEqual(["storybloq"]);
  });

  it("a failure after staging began (an unreadable runtime file) leaves the previous copy byte-identical and no stage behind", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await installMods({ bin });
    const before = await snapshotTree(modsDir());
    expect(before.has(".claude-plugin/plugin.json")).toBe(true);
    expect(before.has("hooks/install.ts")).toBe(true);
    const bad = join(tempDir, "bad-plugin");
    await mkdir(join(bad, ".claude-plugin"), { recursive: true });
    await mkdir(join(bad, "hooks"), { recursive: true });
    await writeFile(join(bad, ".claude-plugin", "plugin.json"), await readFile(join(PLUGIN_SRC, ".claude-plugin", "plugin.json")));
    for (const name of ["hooks.json", "mod.ts", "client-api.ts", "sidebar-projection.ts"]) {
      await writeFile(join(bad, "hooks", name), await readFile(join(PLUGIN_SRC, "hooks", name)));
    }
    // sidebar.ts exists (validation passes) but is a directory: the read fails mid-stage.
    await mkdir(join(bad, "hooks", "sidebar.ts"));
    await expect(installMods({ bin: "/elsewhere/storybloq", sourceDir: bad })).rejects.toThrow();
    expect(await snapshotTree(modsDir())).toEqual(before);
    expect(await readdir(join(tempDir, ".claude", "skills"))).toEqual(["storybloq"]);
  });

  it("a source whose hooks are incomplete is refused before anything is swapped in", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await installMods({ bin });
    const before = await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8");
    // A source with a manifest but no hooks/mod.ts: the copy would load nothing.
    const broken = join(tempDir, "broken-plugin");
    await mkdir(join(broken, ".claude-plugin"), { recursive: true });
    await mkdir(join(broken, "hooks"), { recursive: true });
    await writeFile(join(broken, ".claude-plugin", "plugin.json"), "{}", "utf-8");
    await expect(installMods({ bin, sourceDir: broken })).rejects.toThrow(/mod\.ts|hooks\.json/);
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toBe(before);
  });

  it("the copy passes the client's own validation and scans the same hooks and calls as the repository plugin", async () => {
    let available = true;
    try {
      execFileSync("claude", ["--version"], { stdio: "pipe" });
    } catch {
      available = false;
    }
    expect(available, "claude is not on PATH, so the installed copy cannot be validated").toBe(true);
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "bin"));
    await installMods({ bin });
    const env = { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" };
    const scanOf = (dir: string) =>
      execFileSync("claude", ["plugin", "validate", dir], { encoding: "utf8", env })
        .split("\n")
        .filter((row) => row.includes("mod.ts hooks:") || row.includes("mod.ts calls:"))
        .map((row) => row.trim());
    const installed = execFileSync("claude", ["plugin", "validate", modsDir()], { encoding: "utf8", env });
    expect(installed).toContain("Validation passed");
    const copyScan = scanOf(modsDir());
    const repoScan = scanOf(PLUGIN_SRC);
    // Two lines (the sidebar reads no environment, so the scan prints no env
    // line), each once and each with a payload: an empty scan on both sides
    // would otherwise compare equal.
    expect(copyScan).toHaveLength(2);
    for (const label of ["mod.ts hooks:", "mod.ts calls:"]) {
      const rows = copyScan.filter((row) => row.includes(label));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.split(label)[1]!.trim().length).toBeGreaterThan(0);
    }
    expect(copyScan.find((row) => row.includes("mod.ts hooks:"))).toContain("ui.render");
    expect(copyScan.find((row) => row.includes("mod.ts calls:"))).toContain("$.fs.read (via drainChunk, readHeader)");
    expect(copyScan).toEqual(repoScan);
  });
});

describe("installMods self-overlap guard (ISS-1234)", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-mods-overlap-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  /** A copy of the repository plugin under `root`, plus files a sync would delete. */
  async function pluginSource(root: string): Promise<void> {
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "hooks"), { recursive: true });
    await writeFile(join(root, ".claude-plugin", "plugin.json"), await readFile(join(PLUGIN_SRC, ".claude-plugin", "plugin.json")));
    for (const name of await readdir(join(PLUGIN_SRC, "hooks"))) {
      await writeFile(join(root, "hooks", name), await readFile(join(PLUGIN_SRC, "hooks", name)));
    }
    await writeFile(join(root, "LICENSE"), "the licence a sync deletes\n", "utf-8");
    await mkdir(join(root, "skills", "story"), { recursive: true });
    await writeFile(join(root, "skills", "story", "SKILL.md"), "# the skill a sync deletes\n", "utf-8");
  }

  it("refuses when ~/.claude/skills/storybloq is a symlink to the plugin source, names both paths, and touches nothing (M-NO-OVERLAP-GUARD)", async () => {
    if (process.platform === "win32") return;
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const source = join(tempDir, "workspace", "storybloq", "plugins", "storybloq");
    await pluginSource(source);
    await mkdir(dirname(modsDir()), { recursive: true });
    await symlink(source, modsDir());
    const before = await snapshotTree(source);

    const attempt = installMods({ bin: "/elsewhere/storybloq", sourceDir: source });
    await expect(attempt).rejects.toThrow(/refusing to install/);
    await expect(installMods({ bin: "/elsewhere/storybloq", sourceDir: source })).rejects.toThrow(source);

    expect((await lstat(modsDir())).isSymbolicLink()).toBe(true);
    expect(await snapshotTree(source)).toEqual(before);
    expect(existsSync(join(source, "hooks", ".storybloq-bin"))).toBe(false);
    const siblings = (await readdir(dirname(modsDir()))).filter((n) => n !== "storybloq");
    expect(siblings).toEqual([]);
  });

  it("still installs through a symlink to an unrelated directory (issue #12 stays), link intact", async () => {
    if (process.platform === "win32") return;
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const real = join(tempDir, "dotfiles", "storybloq-mods");
    await mkdir(real, { recursive: true });
    await mkdir(dirname(modsDir()), { recursive: true });
    await symlink(real, modsDir());

    const result = await installMods({ bin: "/elsewhere/storybloq" });

    expect(result.dir).toBe(modsDir());
    expect((await lstat(modsDir())).isSymbolicLink()).toBe(true);
    expect(await readFile(join(real, "hooks", "install.ts"), "utf-8")).toContain('return "/elsewhere/storybloq";');
    expect(existsSync(join(real, "hooks", "mod.ts"))).toBe(true);
  });
});

describe("the version-marker refresh re-resolves the binary (pen hold 1, T-507)", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-mods-refresh-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    process.env.HOME = tempDir;
    // A stale Claude skill install, as skill-version-marker.test.ts sets one up.
    const skillDir = join(tempDir, ".claude", "skills", "story");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# stub\n", "utf-8");
    await writeFile(join(skillDir, ".storybloq-version"), "1.1.0\n", "utf-8");
    await mkdir(join(tempDir, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(tempDir, { recursive: true, force: true });
    const { vi } = await import("vitest");
    vi.resetModules();
  });

  it("moves the generated path with the binary: installed under one PATH, refreshed under another (M-NO-RERESOLVE)", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const oldBin = await fakeBin(join(tempDir, "nvm", "v20", "bin"));
    await installMods({ bin: oldBin });
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toContain(JSON.stringify(oldBin));

    const newBin = await fakeBin(join(tempDir, "nvm", "v22", "bin"));
    process.env.PATH = dirname(newBin);
    const { autoRefreshSkillIfStale, refreshOwner } = await import("../../src/core/skill-version-marker.js");
    refreshOwner.override = () => "owner"; // ISS-1323: run as the global install
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);

    const installTs = await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8");
    expect(installTs).toContain(`return ${JSON.stringify(newBin)};`);
    expect(installTs).not.toContain(oldBin);
    // The runtime files came along too, not only install.ts.
    expect(await readFile(join(modsDir(), "hooks", "sidebar.ts"), "utf-8")).toBe(
      await readFile(join(PLUGIN_SRC, "hooks", "sidebar.ts"), "utf-8"),
    );
  });

  it("follows the binary at the SAME storybloq version: marker current, PATH switched, install.ts answers the new path (M-NO-PATH-TRACK)", async () => {
    const { installMods, modsDir, readModsBin } = await import("../../src/core/mods-install.js");
    const oldBin = await fakeBin(join(tempDir, "nvm", "v20", "bin"));
    await installMods({ bin: oldBin });
    expect(readModsBin()).toBe(oldBin);
    // The skill is current: the stale branch must not be what moves the path.
    await markSkillCurrent(tempDir, "1.1.6");

    const newBin = await fakeBin(join(tempDir, "nvm", "v22", "bin"));
    process.env.PATH = dirname(newBin);
    const { autoRefreshSkillIfStale, refreshOwner } = await import("../../src/core/skill-version-marker.js");
    refreshOwner.override = () => "owner"; // ISS-1323: run as the global install
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(false); // nothing stale, and still:
    const installTs = await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8");
    expect(installTs).toContain(`return ${JSON.stringify(newBin)};`);
    expect(installTs).not.toContain(oldBin);
    expect(readModsBin()).toBe(newBin);
  });

  it("with the binary unchanged the copy is left alone: no file is rewritten (M-RECOPY-ALWAYS)", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "nvm", "v20", "bin"));
    await installMods({ bin });
    await markSkillCurrent(tempDir, "1.1.6");
    process.env.PATH = dirname(bin);
    const { stat } = await import("node:fs/promises");
    const before = new Map<string, number>();
    for (const [rel] of await snapshotTree(modsDir())) before.set(rel, (await stat(join(modsDir(), rel))).mtimeMs);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { autoRefreshSkillIfStale, refreshOwner } = await import("../../src/core/skill-version-marker.js");
    refreshOwner.override = () => "owner"; // ISS-1323: run as the global install
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(false);
    for (const [rel, mtime] of before) {
      expect((await stat(join(modsDir(), rel))).mtimeMs, rel).toBe(mtime);
    }
  });

  it("a copy from before the sidecar is rewritten once to gain it, then left alone", async () => {
    const { installMods, modsDir, readModsBin, MODS_BIN_FILE } = await import("../../src/core/mods-install.js");
    const bin = await fakeBin(join(tempDir, "nvm", "v20", "bin"));
    await installMods({ bin });
    await rm(join(modsDir(), "hooks", MODS_BIN_FILE));
    expect(readModsBin()).toBeUndefined();
    await markSkillCurrent(tempDir, "1.1.6");
    process.env.PATH = dirname(bin);
    const { autoRefreshSkillIfStale, refreshOwner } = await import("../../src/core/skill-version-marker.js");
    refreshOwner.override = () => "owner"; // ISS-1323: run as the global install
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(false);
    expect(readModsBin()).toBe(bin);
  });

  it("installs no Mods copy where none was installed: the refresh is not a setup", async () => {
    const { modsDir } = await import("../../src/core/mods-install.js");
    process.env.PATH = dirname(await fakeBin(join(tempDir, "bin")));
    const { autoRefreshSkillIfStale, refreshOwner } = await import("../../src/core/skill-version-marker.js");
    refreshOwner.override = () => "owner"; // ISS-1323: run as the global install
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);
    expect(existsSync(modsDir())).toBe(false);
  });

  it("with the binary gone from PATH the refresh keeps the copy loadable, answering the bare name", async () => {
    const { installMods, modsDir } = await import("../../src/core/mods-install.js");
    await installMods({ bin: await fakeBin(join(tempDir, "old", "bin")) });
    process.env.PATH = "";
    const { autoRefreshSkillIfStale, refreshOwner } = await import("../../src/core/skill-version-marker.js");
    refreshOwner.override = () => "owner"; // ISS-1323: run as the global install
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);
    expect(await readFile(join(modsDir(), "hooks", "install.ts"), "utf-8")).toContain('return "storybloq";');
    expect(existsSync(join(modsDir(), "hooks", "mod.ts"))).toBe(true);
  });
});

describe("setup-skill wires the Mods copy (T-507 D)", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;
  let out: string[];
  let err: string[];
  let stdoutSpy: { mockRestore: () => void } | null = null;
  let stderrSpy: { mockRestore: () => void } | null = null;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-mods-setup-${randomUUID()}`);
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    process.env.HOME = tempDir;
    // Shims: a storybloq the resolver finds, and a claude whose `mcp add` succeeds, so the
    // handler runs its whole path inside this HOME (settings.json, .claude.json, skills/).
    const shims = join(tempDir, "shims");
    await fakeBin(shims);
    await writeFile(join(shims, "claude"), "#!/bin/sh\nexit 0\n", "utf-8");
    await chmod(join(shims, "claude"), 0o755);
    process.env.PATH = shims;
    out = [];
    err = [];
    const { vi } = await import("vitest");
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { err.push(String(chunk)); return true; }) as never);
  });

  afterEach(async () => {
    stdoutSpy?.mockRestore();
    stderrSpy?.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(tempDir, { recursive: true, force: true });
    const { vi } = await import("vitest");
    vi.doUnmock("../../src/core/mods-install.js");
    vi.resetModules();
  });

  it("handleSetup --client claude installs the copy with the binary it resolved, and says so", async () => {
    const { handleSetup, MODS_WIDTH_NOTE } = await import("../../src/cli/commands/setup-skill.js");
    await handleSetup({ client: "claude" });
    const installTs = await readFile(join(tempDir, ".claude", "skills", "storybloq", "hooks", "install.ts"), "utf-8");
    expect(installTs).toContain(`return ${JSON.stringify(join(tempDir, "shims", "storybloq"))};`);
    expect(existsSync(join(tempDir, ".claude", "skills", "storybloq", "hooks", "mod.ts"))).toBe(true);
    expect(out.join("")).toContain("Installed Mods (function hooks) at ~/.claude/skills/storybloq/");
    expect(err.join("")).not.toContain("Mods copy failed");
    // ISS-1235: setup says what width the board needs, once, unmeasured.
    expect(out.join("")).toContain("fullscreen renderer");
    expect(MODS_WIDTH_NOTE).toContain("fullscreen renderer");
    // ISS-1247: docking is the renderer's, not a column count; the 144 is the
    // floor for the plugin's own open, and the first prompt lifts it (ISS-1251).
    expect(MODS_WIDTH_NOTE).not.toContain("144+ columns wide");
    expect(MODS_WIDTH_NOTE).toContain("until your first prompt");

    // T-516: the copy is inert unless the client is allowed to load hooks
    // modules, so the same run writes the settings switch and says it did.
    const settings = JSON.parse(await readFile(join(tempDir, ".claude", "settings.json"), "utf-8")) as {
      env?: Record<string, unknown>;
    };
    expect(settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS).toBe("1");
    expect(out.join("")).toContain("Set env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1");
  });

  it("a failing Mods copy is a warning, and the rest of the Claude setup still completes", async () => {
    const { vi } = await import("vitest");
    vi.doMock("../../src/core/mods-install.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/core/mods-install.js")>();
      return { ...actual, installMods: async () => { throw new Error("disk full (simulated)"); } };
    });
    const { handleSetup } = await import("../../src/cli/commands/setup-skill.js");
    await expect(handleSetup({ client: "claude" })).resolves.toBeUndefined();
    expect(err.join("")).toContain("Warning: Mods copy failed (non-fatal): disk full (simulated)");
    expect(existsSync(join(tempDir, ".claude", "skills", "storybloq"))).toBe(false);
    // The /story skill still landed (the marker is best-effort and, in the
    // source layout, has no package.json beside dist/ to read a version from).
    expect(existsSync(join(tempDir, ".claude", "skills", "story", "SKILL.md"))).toBe(true);
  });
});
