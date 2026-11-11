/**
 * ISS-1323, end to end through two built CLIs: only the package `npm root -g`
 * names as @storybloq/storybloq may refresh the global skill copy. A second
 * package (a clone's dist/cli.js, with a skill bundle one byte apart) used to
 * copy its bundle over the global copy on every command, and the global CLI
 * copied its own back on the next: a ping-pong. Now the package that is not
 * the global install leaves the copy alone and says so, and the copy is
 * rewritten at most once, by the owner.
 *
 * HOME is the fixture's own (E2ECliFixture); `npm` is a stub first on PATH, so
 * the machine's real global install is never consulted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, cp, link, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2ECliFixture, runE2ECli, type RunE2ECliResult } from "../helpers/e2e-cli.js";
import { OWNERSHIP_CACHE_FILE, SKILL_FINGERPRINT_FILE } from "../../src/core/skill-version-marker.js";

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");

async function cliVersion(): Promise<string> {
  return (JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf-8")) as { version: string }).version;
}

/** Every file under a directory, recursively, with its bytes and mtime. */
async function snapshot(dir: string, prefix = "", out: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    const key = prefix + entry.name;
    if (entry.isDirectory()) await snapshot(p, `${key}/`, out);
    else out[key] = `${(await stat(p)).mtimeMs}:${await readFile(p, "utf-8")}`;
  }
  return out;
}

describe("ISS-1323: a CLI that is not the global install never rewrites the global skill copy", () => {
  let fixture: E2ECliFixture;
  let skillDir: string;
  let other: string;
  let env: Record<string, string>;
  let counter: string;
  let global: string;
  let stubs: string;

  beforeEach(async () => {
    fixture = await E2ECliFixture.create();

    // A second package, laid out as npm installs one (package.json `files`),
    // with one byte of its skill bundle changed. Its bare imports resolve
    // through this package's node_modules.
    other = join(fixture.root, "other-pkg");
    await mkdir(other, { recursive: true });
    await cp(join(pkgRoot, "dist"), join(other, "dist"), { recursive: true });
    await cp(join(pkgRoot, "src", "skill"), join(other, "src", "skill"), { recursive: true });
    await writeFile(
      join(other, "src", "skill", "SKILL.md"),
      (await readFile(join(pkgRoot, "src", "skill", "SKILL.md"), "utf-8")) + "\n<!-- the other package -->\n",
      "utf-8",
    );
    const hooks = join(pkgRoot, "plugins", "storybloq", "hooks");
    await mkdir(join(other, "plugins", "storybloq", "hooks"), { recursive: true });
    for (const name of await readdir(hooks)) {
      if (name === "hooks.json" || (name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
        await cp(join(hooks, name), join(other, "plugins", "storybloq", "hooks", name));
      }
    }
    const manifest = join(pkgRoot, "plugins", "storybloq", ".claude-plugin");
    if (existsSync(manifest)) await cp(manifest, join(other, "plugins", "storybloq", ".claude-plugin"), { recursive: true });
    await cp(join(pkgRoot, "package.json"), join(other, "package.json"));
    await symlink(join(pkgRoot, "node_modules"), join(other, "node_modules"));

    // npm names the second package as the global install.
    global = join(fixture.root, "npm-global");
    stubs = join(fixture.root, "npm-stub");
    counter = join(fixture.root, "npm-spawns");
    await mkdir(join(global, "@storybloq"), { recursive: true });
    await mkdir(stubs, { recursive: true });
    await symlink(other, join(global, "@storybloq", "storybloq"));
    // A node script, as npm itself is (ISS-1493 O2: a shell shim bypasses the cache).
    await writeFile(join(stubs, "npm"), npmScript(`console.log(${JSON.stringify(global)});`), "utf-8");
    await chmod(join(stubs, "npm"), 0o755);
    env = { PATH: [stubs, process.env.PATH ?? ""].join(delimiter) };

    // A copy at the running version recorded against a third bundle: stale
    // for both packages.
    skillDir = join(fixture.home, ".claude", "skills", "story");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# a copy from some earlier bundle\n", "utf-8");
    await writeFile(join(skillDir, ".storybloq-version"), `${await cliVersion()}\n`, "utf-8");
    await writeFile(join(skillDir, SKILL_FINGERPRINT_FILE), `sha256:${"0".repeat(64)}\n`, "utf-8");
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  function npmScript(body: string): string {
    return `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(counter)}, "x\\n");\n${body}\n`;
  }

  /** The CLI under this test's own node, so only npm's interpreter varies with PATH. */
  function callFixed(extra: Record<string, string>): void {
    const r = spawnSync(process.execPath, [join(pkgRoot, "dist", "cli.js"), "reference", "--format", "json"], {
      cwd: fixture.root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: fixture.env({ ...env, ...extra }), timeout: 30_000,
    });
    if (r.error) throw r.error;
    expect(r.status, r.stderr).toBe(0);
  }

  function runOther(args: string[]): RunE2ECliResult {
    const res = spawnSync("node", [join(other, "dist", "cli.js"), ...args], {
      cwd: fixture.root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: fixture.env(env),
      timeout: 30_000,
    });
    if (res.error) throw res.error;
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  it("foreign leaves it alone with one notice, the owner refreshes once, foreign again writes nothing", async () => {
    const notice = "skill files not refreshed";
    const initial = await snapshot(skillDir);

    const first = runE2ECli(fixture, ["reference", "--format", "json"], { env });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr.split("\n").filter((l) => l.includes(notice))).toHaveLength(1);
    expect(first.stderr).not.toContain("refreshed skill files");
    expect(await snapshot(skillDir)).toEqual(initial);

    const owner = runOther(["reference", "--format", "json"]);
    expect(owner.status, owner.stderr).toBe(0);
    expect(owner.stderr).toContain("(same version, bundled skill changed)");
    expect(owner.stderr).not.toContain(notice);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf-8"))
      .toBe(await readFile(join(other, "src", "skill", "SKILL.md"), "utf-8"));
    const refreshed = await snapshot(skillDir);

    const again = runE2ECli(fixture, ["reference", "--format", "json"], { env });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).toContain(notice);
    expect(again.stderr).not.toContain("refreshed skill files");
    expect(await snapshot(skillDir)).toEqual(refreshed);

    const ownerAgain = runOther(["reference", "--format", "json"]);
    expect(ownerAgain.status, ownerAgain.stderr).toBe(0);
    expect(ownerAgain.stderr).not.toContain("refreshed skill files");
    expect(await snapshot(skillDir)).toEqual(refreshed);
  });

  // ISS-1493: the verdict is remembered across processes, keyed on what it was computed from.
  const NOTICE = "skill files not refreshed";
  const notices = (r: RunE2ECliResult): number => r.stderr.split("\n").filter((l) => l.includes(NOTICE)).length;
  async function spawns(): Promise<number> {
    return existsSync(counter) ? (await readFile(counter, "utf-8")).split("\n").filter(Boolean).length : 0;
  }
  function foreign(extra: Record<string, string> = {}): RunE2ECliResult {
    const r = runE2ECli(fixture, ["reference", "--format", "json"], { env: { ...env, ...extra } });
    expect(r.status, r.stderr).toBe(0);
    return r;
  }
  async function unmark(): Promise<void> {
    await rm(join(skillDir, ".storybloq-version"), { force: true });
    await rm(join(skillDir, SKILL_FINGERPRINT_FILE), { force: true });
  }
  const cacheFile = (): string => join(fixture.globalDir, OWNERSHIP_CACHE_FILE);

  it("ISS-1493 R1: an unmarked copy, two calls in the same state: the second spawns no npm, prints no notice and writes nothing under HOME", async () => {
    await unmark();
    const first = foreign();
    expect(await spawns()).toBe(1);
    expect(notices(first)).toBe(1);
    expect(existsSync(cacheFile())).toBe(true);
    const home = await snapshot(fixture.home);
    const globalState = await snapshot(fixture.globalDir);
    const second = foreign();
    expect(await spawns()).toBe(1);
    expect(notices(second)).toBe(0);
    expect(await snapshot(fixture.home)).toEqual(home);
    expect(await snapshot(fixture.globalDir)).toEqual(globalState);
    expect(existsSync(join(fixture.home, ".npm"))).toBe(false);
  });

  it("ISS-1493 R2: a changed global install invalidates the entry", async () => {
    await unmark();
    foreign();
    foreign();
    expect(await spawns()).toBe(1);
    await writeFile(join(other, "package.json"), `${await readFile(join(other, "package.json"), "utf-8")}\n`, "utf-8");
    foreign();
    expect(await spawns()).toBe(2);
    foreign();
    expect(await spawns()).toBe(2);
  });

  it("ISS-1493 R3: a changed skill marker state recomputes once and notices once for the new state", async () => {
    await unmark();
    foreign();
    expect(notices(foreign())).toBe(0);
    await writeFile(join(skillDir, ".storybloq-version"), "0.0.1\n", "utf-8");
    const changed = foreign();
    expect(await spawns()).toBe(2);
    expect(notices(changed)).toBe(1);
    expect(notices(foreign())).toBe(0);
    expect(await spawns()).toBe(2);
  });

  it("ISS-1493 R4: a changed npm prefix input recomputes", async () => {
    await unmark();
    foreign({ npm_config_prefix: join(fixture.root, "prefix-a") });
    foreign({ npm_config_prefix: join(fixture.root, "prefix-a") });
    expect(await spawns()).toBe(1);
    foreign({ npm_config_prefix: join(fixture.root, "prefix-b") });
    expect(await spawns()).toBe(2);
  });

  it("ISS-1493 R5: a corrupt, oversized or symlinked entry is a miss and is replaced by a regular file; a symlink's target is untouched", async () => {
    await unmark();
    await writeFile(cacheFile(), "{", "utf-8");
    foreign();
    expect(await spawns()).toBe(1);
    expect(JSON.parse(await readFile(cacheFile(), "utf-8"))).toMatchObject({ version: 1, verdict: "foreign" });

    await writeFile(cacheFile(), " ".repeat(20_000) + (await readFile(cacheFile(), "utf-8")), "utf-8");
    foreign();
    expect(await spawns()).toBe(2);

    const decoy = join(fixture.root, "decoy.json");
    const valid = await readFile(cacheFile(), "utf-8");
    await writeFile(decoy, valid, "utf-8");
    await rm(cacheFile());
    await symlink(decoy, cacheFile());
    foreign();
    expect(await spawns()).toBe(3);
    expect(await readFile(decoy, "utf-8")).toBe(valid);
    expect((await lstat(cacheFile())).isFile()).toBe(true);
  });

  it("ISS-1493 R6: an unwritable global dir behaves as before: one spawn and one notice per process, no failure", async () => {
    await unmark();
    await chmod(fixture.globalDir, 0o500);
    try {
      expect(notices(foreign())).toBe(1);
      expect(notices(foreign())).toBe(1);
      expect(await spawns()).toBe(2);
      expect(existsSync(cacheFile())).toBe(false);
    } finally {
      await chmod(fixture.globalDir, 0o700);
    }
  });

  it("ISS-1493 R7: when npm itself fails nothing is cached, and each call asks again", async () => {
    await unmark();
    await writeFile(join(stubs, "npm"), npmScript("process.exit(1);"), "utf-8");
    foreign();
    foreign();
    expect(await spawns()).toBe(2);
    expect(existsSync(cacheFile())).toBe(false);
  });

  it("ISS-1493 R9 (N1): npm switched via PATH, the old global package still in place, recomputes once", async () => {
    await unmark();
    const stubs2 = join(fixture.root, "npm-stub-2");
    await mkdir(stubs2, { recursive: true });
    await writeFile(join(stubs2, "npm"), await readFile(join(stubs, "npm"), "utf-8"), "utf-8");
    await chmod(join(stubs2, "npm"), 0o755);
    foreign();
    foreign();
    expect(await spawns()).toBe(1);
    const path2 = [stubs2, process.env.PATH ?? ""].join(delimiter);
    foreign({ PATH: path2 });
    foreign({ PATH: path2 });
    expect(await spawns()).toBe(2);
  });

  it("ISS-1493 R10 (N1): a switched userconfig recomputes once", async () => {
    await unmark();
    const a = join(fixture.root, "a.npmrc");
    const b = join(fixture.root, "b.npmrc");
    await writeFile(a, "fund=false\n", "utf-8");
    await writeFile(b, "fund=false\n", "utf-8");
    foreign({ npm_config_userconfig: a });
    foreign({ npm_config_userconfig: a });
    expect(await spawns()).toBe(1);
    foreign({ npm_config_userconfig: b });
    foreign({ npm_config_userconfig: b });
    expect(await spawns()).toBe(2);
  });

  it("ISS-1493 R12 (N1): under an nvm-shaped layout, editing <node prefix>/etc/npmrc recomputes once", async () => {
    await unmark();
    // <nvm>/bin/node is a hard link (a copy across volumes) of this node, so
    // its realpath stays inside the layout; <nvm>/bin/npm is a shim into
    // lib/node_modules/npm, as nvm installs it.
    const nvm = join(fixture.root, "nvm");
    const npmPkgBin = join(nvm, "lib", "node_modules", "npm", "bin");
    await mkdir(join(nvm, "bin"), { recursive: true });
    await mkdir(npmPkgBin, { recursive: true });
    await mkdir(join(nvm, "etc"), { recursive: true });
    const node = join(nvm, "bin", "node");
    try { await link(process.execPath, node); } catch { await cp(process.execPath, node); }
    await cp(join(stubs, "npm"), join(npmPkgBin, "npm-cli.js"));
    await chmod(join(npmPkgBin, "npm-cli.js"), 0o755);
    await symlink(join("..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(nvm, "bin", "npm"));
    const rcEnv = {
      PATH: [join(nvm, "bin"), process.env.PATH ?? ""].join(delimiter),
      npm_config_globalconfig: "", NPM_CONFIG_GLOBALCONFIG: "", npm_config_prefix: "", NPM_CONFIG_PREFIX: "", PREFIX: "",
    };
    const call = (): void => {
      const r = spawnSync(node, [join(pkgRoot, "dist", "cli.js"), "reference", "--format", "json"], {
        cwd: fixture.root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: fixture.env({ ...env, ...rcEnv }), timeout: 30_000,
      });
      if (r.error) throw r.error;
      expect(r.status, r.stderr).toBe(0);
    };
    call();
    call();
    expect(await spawns()).toBe(1);
    await writeFile(join(nvm, "etc", "npmrc"), "fund=false\n", "utf-8");
    call();
    call();
    expect(await spawns()).toBe(2);
  }, 30_000);

  it.each([["prefix=/custom"], ["globalconfig=/custom/npmrc"], ["  PREFIX = ${HOME}/x"]])(
    "ISS-1493 R13 (O1): an unchanged ~/.npmrc with %s bypasses the cache, so every call spawns",
    async (line) => {
      await unmark();
      await writeFile(join(fixture.home, ".npmrc"), `fund=false\n${line}\n`, "utf-8");
      const homeRc = { npm_config_userconfig: "", NPM_CONFIG_USERCONFIG: "" };
      foreign(homeRc);
      foreign(homeRc);
      foreign(homeRc);
      expect(await spawns()).toBe(3);
      expect(existsSync(cacheFile())).toBe(false);
    },
    30_000,
  );

  it("ISS-1493 R14 (O2): the same npm script under two PATH layouts that resolve different nodes recomputes once per layout change", async () => {
    const layout = async (name: string): Promise<string> => {
      const bin = join(fixture.root, name, "bin");
      await mkdir(bin, { recursive: true });
      try { await link(process.execPath, join(bin, "node")); } catch { await cp(process.execPath, join(bin, "node")); }
      return [stubs, bin, process.env.PATH ?? ""].join(delimiter);
    };
    await unmark();
    const a = { PATH: await layout("node-a"), npm_config_globalconfig: "", NPM_CONFIG_GLOBALCONFIG: "", npm_config_prefix: "", NPM_CONFIG_PREFIX: "", PREFIX: "" };
    const b = { ...a, PATH: await layout("node-b") };
    callFixed(a);
    callFixed(a);
    expect(await spawns()).toBe(1);
    callFixed(b);
    callFixed(b);
    expect(await spawns()).toBe(2);
    callFixed(a);
    expect(await spawns()).toBe(3);
  }, 30_000);

  it.each([["leading empty", 0], ["middle empty", 1], ["dot", 2]] as const)(
    "ISS-1493 R15 (P1): a PATH with a %s component makes every call spawn and caches nothing",
    async (_name, shape) => {
      await unmark();
      const rest = process.env.PATH ?? "";
      const path = shape === 0 ? ["", stubs, rest] : shape === 1 ? [stubs, "", rest] : [".", stubs, rest];
      const bad = { PATH: path.join(delimiter) };
      foreign(bad);
      foreign(bad);
      foreign(bad);
      expect(await spawns()).toBe(3);
      expect(existsSync(cacheFile())).toBe(false);
    },
    30_000,
  );

  it("ISS-1493 R11 (N2): an oversized ~/.npmrc makes every call spawn and nothing is cached", async () => {
    await unmark();
    await writeFile(join(fixture.home, ".npmrc"), "#".repeat(70_000), "utf-8");
    // The runner may export npm's own userconfig; clear it so ~/.npmrc applies.
    const homeRc = { npm_config_userconfig: "", NPM_CONFIG_USERCONFIG: "" };
    foreign(homeRc);
    foreign(homeRc);
    foreign(homeRc);
    expect(await spawns()).toBe(3);
    expect(existsSync(cacheFile())).toBe(false);
  });
});
