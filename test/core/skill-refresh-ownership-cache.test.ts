/**
 * ISS-1493: the parts of the ownership cache key, each on its own, and the
 * reader's refusals. The cross-process behaviour (spawn counts, the notice)
 * is pinned end to end in test/cli/skill-refresh-ownership.e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  autoRefreshSkillIfStale,
  globalPackageIdentity,
  ownershipCachePath,
  ownershipLocalKey,
  readOwnershipCache,
  refreshOwner,
  refreshOwnershipVerdict,
  skillDir,
} from "../../src/core/skill-version-marker.js";

const CONFIG_ENV = ["npm_config_userconfig", "NPM_CONFIG_USERCONFIG", "npm_config_globalconfig", "NPM_CONFIG_GLOBALCONFIG"] as const;
const SAVED = ["HOME", "PATH", "STORYBLOQ_GLOBAL_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "npm_config_prefix", "NPM_CONFIG_PREFIX", "PREFIX", ...CONFIG_ENV] as const;

/** An npm stub at <root>/<name>/bin/npm that prints <root>/npm-global; returns the bin dir. */
function npmStub(name: string): string {
  const bin = join(root, name, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(join(root, "npm-global"))});\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return bin;
}
const NODE_BIN = dirname(process.execPath);
const usePath = (bin: string): void => { process.env.PATH = [bin, NODE_BIN, "/usr/bin", "/bin"].join(delimiter); };
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), "iss1493-"));
  for (const d of ["home", "global", "codex"]) mkdirSync(join(root, d));
  process.env.HOME = join(root, "home");
  process.env.STORYBLOQ_GLOBAL_DIR = join(root, "global");
  process.env.CODEX_HOME = join(root, "codex");
  delete process.env.CLAUDE_CONFIG_DIR;
  for (const k of ["npm_config_prefix", "NPM_CONFIG_PREFIX", "PREFIX", ...CONFIG_ENV]) delete process.env[k];
  usePath(npmStub("npm-a"));
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  refreshOwner.override = null;
  refreshOwner.memo = null;
  refreshOwner.noticed = false;
  refreshOwner.cache = null;
  refreshOwner.beforePersist = null;
  rmSync(root, { recursive: true, force: true });
});

const keyJson = async (): Promise<string> => JSON.stringify(await ownershipLocalKey());

describe("ISS-1493: the local key flips on each of its parts alone", () => {
  it("is stable when nothing changes", async () => {
    const k = await ownershipLocalKey();
    expect(k).not.toBeNull();
    expect(await keyJson()).toBe(JSON.stringify(k));
  });

  it("the skill marker state: SKILL.md appearing, then a marker, then a fingerprint", async () => {
    const dir = skillDir("claude");
    const a = await keyJson();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# copy\n");
    const b = await keyJson();
    writeFileSync(join(dir, ".storybloq-version"), "1.0.0\n");
    const c = await keyJson();
    writeFileSync(join(dir, ".storybloq-skill-fingerprint"), `sha256:${"1".repeat(64)}\n`);
    const d = await keyJson();
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("each npm prefix env value", async () => {
    const seen = new Set([await keyJson()]);
    for (const k of ["npm_config_prefix", "NPM_CONFIG_PREFIX", "PREFIX"]) {
      process.env[k] = join(root, k);
      seen.add(await keyJson());
    }
    expect(seen.size).toBe(4);
  });

  it("the user npmrc's content", async () => {
    const a = await keyJson();
    writeFileSync(join(root, "home", ".npmrc"), "fund=false\n");
    const b = await keyJson();
    writeFileSync(join(root, "home", ".npmrc"), "fund=true\n");
    expect(new Set([a, b, await keyJson()]).size).toBe(3);
  });
});

describe("ISS-1493 N1: the inputs npm reads to answer root -g", () => {
  it("the npm found on PATH", async () => {
    const a = await keyJson();
    usePath(npmStub("npm-b"));
    const b = await keyJson();
    expect(a).not.toBe(b);
    expect(JSON.parse(b).npm).toContain("npm-b");
  });

  it("no npm on PATH bypasses the cache", async () => {
    mkdirSync(join(root, "empty-bin"));
    process.env.PATH = join(root, "empty-bin");
    expect(await ownershipLocalKey()).toBeNull();
  });

  it("each userconfig and globalconfig env value", async () => {
    const seen = new Set([await keyJson()]);
    for (const k of CONFIG_ENV) {
      process.env[k] = join(root, `${k}.rc`);
      seen.add(await keyJson());
    }
    expect(seen.size).toBe(5);
  });

  it("the content of the userconfig the env names", async () => {
    const rc = join(root, "user.rc");
    process.env.npm_config_userconfig = rc;
    const a = await keyJson();
    writeFileSync(rc, "fund=false\n");
    const b = await keyJson();
    writeFileSync(rc, "fund=true\n");
    expect(new Set([a, b, await keyJson()]).size).toBe(3);
  });

  it("the content of the global npmrc under the configured prefix, and of the one the env names", async () => {
    process.env.npm_config_prefix = join(root, "prefix");
    const beside = join(root, "prefix", "etc", "npmrc");
    const a = await keyJson();
    mkdirSync(join(root, "prefix", "etc"), { recursive: true });
    writeFileSync(beside, "fund=false\n");
    const b = await keyJson();
    const named = join(root, "global.rc");
    writeFileSync(named, "audit=false\n");
    process.env.NPM_CONFIG_GLOBALCONFIG = named;
    const c = await keyJson();
    writeFileSync(named, "audit=true\n");
    expect(new Set([a, b, c, await keyJson()]).size).toBe(4);
  });
});

describe("ISS-1493 P1: a PATH with an empty or relative component bypasses the cache", () => {
  it.each<[string, (bin: string) => string]>([
    ["leading empty, the literal case", () => ":/usr/bin"],
    ["middle empty, the literal case", () => "/usr/bin::/bin"],
    ["dot first, the literal case", () => ".:/usr/bin"],
    ["leading empty before a usable npm", (bin) => ["", bin, NODE_BIN].join(delimiter)],
    ["middle empty between a usable npm and node", (bin) => [bin, "", NODE_BIN].join(delimiter)],
    ["trailing empty after a usable npm", (bin) => [bin, NODE_BIN, ""].join(delimiter)],
    ["dot before a usable npm", (bin) => [".", bin, NODE_BIN].join(delimiter)],
    ["a relative folder after a usable npm", (bin) => [bin, NODE_BIN, "rel/bin"].join(delimiter)],
  ])("%s gives no key", async (_name, path) => {
    process.env.PATH = path(join(root, "npm-a", "bin"));
    expect(await ownershipLocalKey()).toBeNull();
  });

  it("control: the same npm on an all-absolute PATH keys", async () => {
    process.env.PATH = [join(root, "npm-a", "bin"), NODE_BIN].join(delimiter);
    expect(await ownershipLocalKey()).not.toBeNull();
  });
});

describe("ISS-1493 O1: a config that moves npm's prefix or globalconfig bypasses the cache", () => {
  it.each([["prefix=/custom"], ["globalconfig=/x/npmrc"], ["  Prefix = ${HOME}/x"], ["GLOBALCONFIG"]])("~/.npmrc with %s gives no key", async (line) => {
    writeFileSync(join(root, "home", ".npmrc"), `fund=false\n${line}\n`);
    expect(await ownershipLocalKey()).toBeNull();
  });

  it("a global npmrc with prefix gives no key; a comment naming it does not", async () => {
    const named = join(root, "global.rc");
    process.env.npm_config_globalconfig = named;
    writeFileSync(named, "; prefix=/x\n# globalconfig=/y\nfund=false\n");
    expect(await ownershipLocalKey()).not.toBeNull();
    writeFileSync(named, "prefix=/x\n");
    expect(await ownershipLocalKey()).toBeNull();
  });
});

describe("ISS-1493 O2: npm's interpreter", () => {
  function npmWith(name: string, shebang: string): string {
    const bin = join(root, name);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm"), `${shebang}\nconsole.log("x");\n`);
    chmodSync(join(bin, "npm"), 0o755);
    return bin;
  }

  it("#!/usr/bin/env node keys on the node found on PATH", async () => {
    expect((await ownershipLocalKey())?.node).toBe(realpathSync(process.execPath));
  });

  it("an absolute node path is used as is, and sets the default prefix", async () => {
    const nodeDir = join(root, "abs", "bin");
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, "node"), "");
    usePath(npmWith("npm-abs", `#!${join(nodeDir, "node")}`));
    const k = await ownershipLocalKey();
    expect(k?.node).toBe(realpathSync(join(nodeDir, "node")));
    mkdirSync(join(root, "abs", "etc"));
    writeFileSync(join(root, "abs", "etc", "npmrc"), "fund=false\n");
    expect((await ownershipLocalKey())?.globalconfig).not.toBe(k?.globalconfig);
  });

  it.each([["#!/bin/sh"], ["#!/usr/bin/env bash"], ["#!/usr/bin/env -S node --x"], ["no shebang"]])("%s gives no key", async (shebang) => {
    usePath(npmWith("npm-other", shebang));
    expect(await ownershipLocalKey()).toBeNull();
  });
});

describe("ISS-1493 N2: a missing config is absent, an unreadable one disables the cache", () => {
  it("a missing ~/.npmrc is absent and the key exists", async () => {
    expect((await ownershipLocalKey())?.userconfig).toBe("absent");
  });

  it.each([
    ["oversized", () => writeFileSync(join(root, "home", ".npmrc"), "#".repeat(70_000))],
    ["a directory", () => mkdirSync(join(root, "home", ".npmrc"))],
    ["unreadable", () => { writeFileSync(join(root, "home", ".npmrc"), "x=1\n"); chmodSync(join(root, "home", ".npmrc"), 0o000); }],
  ])("an existing ~/.npmrc that is %s gives no key", async (name, make) => {
    make();
    if (name === "unreadable" && process.getuid?.() === 0) return;
    expect(await ownershipLocalKey()).toBeNull();
  });

  it("an oversized global npmrc gives no key", async () => {
    const named = join(root, "global.rc");
    writeFileSync(named, "#".repeat(70_000));
    process.env.npm_config_globalconfig = named;
    expect(await ownershipLocalKey()).toBeNull();
  });
});

describe("ISS-1493 N3: the entry is written only for the package the verdict was read from", () => {
  function installGlobal(): string {
    const pkg = join(root, "npm-global", "@storybloq", "storybloq");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"@storybloq/storybloq"}');
    return pkg;
  }

  it("control: an unchanged package is persisted with the identity it was read under", async () => {
    installGlobal();
    const identity = globalPackageIdentity(join(root, "npm-global"));
    await refreshOwnershipVerdict();
    expect(readOwnershipCache()).toMatchObject({ globalPackage: identity, verdict: "foreign" });
  });

  it("a package replaced between resolving and persisting writes no entry", async () => {
    const pkg = installGlobal();
    refreshOwner.beforePersist = () => writeFileSync(join(pkg, "package.json"), '{"name":"@storybloq/storybloq","version":"9"}');
    await refreshOwnershipVerdict();
    expect(existsSync(ownershipCachePath())).toBe(false);
  });
});

describe("ISS-1493: the global package identity", () => {
  it("is absent with no package, and changes on install and on rewrite", () => {
    const npmRoot = join(root, "npm-root");
    expect(globalPackageIdentity(npmRoot)).toBe("absent");
    const pkg = join(npmRoot, "@storybloq", "storybloq");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"@storybloq/storybloq"}');
    const installed = globalPackageIdentity(npmRoot);
    expect(installed).not.toBe("absent");
    writeFileSync(join(pkg, "package.json"), '{"name":"@storybloq/storybloq","version":"2"}');
    expect(globalPackageIdentity(npmRoot)).not.toBe(installed);
  });
});

describe("ISS-1493: the reader refuses anything but a regular, bounded, well-shaped entry", () => {
  let entry: Record<string, unknown>;
  beforeEach(async () => {
    entry = { version: 1, local: await ownershipLocalKey(), npmRoot: "/x", globalPackage: "absent", verdict: "foreign", runningRoot: null, globalRoot: null, noticed: false };
  });

  it("reads a well-shaped entry", () => {
    writeFileSync(ownershipCachePath(), JSON.stringify(entry));
    expect(readOwnershipCache()).toMatchObject({ verdict: "foreign" });
  });

  const local = (): Record<string, unknown> => entry.local as Record<string, unknown>;
  it.each<[string, () => string]>([
    ["bad JSON", () => "{"],
    ["a wrong version", () => JSON.stringify({ ...entry, version: 2 })],
    ["an unknown verdict", () => JSON.stringify({ ...entry, verdict: "maybe" })],
    ["oversized", () => " ".repeat(20_000) + JSON.stringify(entry)],
    ["an empty local key", () => JSON.stringify({ ...entry, local: {} })],
    ["a local key missing its npm", () => { const { npm: _n, ...rest } = local(); return JSON.stringify({ ...entry, local: rest }); }],
    ["a local key with a malformed config env", () => JSON.stringify({ ...entry, local: { ...local(), configEnv: [1, null, null, null] } })],
    ["a local key with a malformed skill row", () => JSON.stringify({ ...entry, local: { ...local(), skills: [{ dir: 1 }] } })],
  ])("%s is a miss", (_name, body) => {
    writeFileSync(ownershipCachePath(), body());
    expect(readOwnershipCache()).toBeNull();
  });

  it("a symlink to a valid entry is a miss", () => {
    const real = join(root, "real.json");
    writeFileSync(real, JSON.stringify(entry));
    symlinkSync(real, ownershipCachePath());
    expect(readOwnershipCache()).toBeNull();
  });

  it("a FIFO at the path is a miss and does not hang", () => {
    execFileSync("mkfifo", [ownershipCachePath()]);
    expect(readOwnershipCache()).toBeNull();
  });
});

describe("ISS-1493 R8: the test override bypasses the disk", () => {
  it("a foreign override declines and writes no cache entry", async () => {
    const dir = skillDir("claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# old copy\n");
    writeFileSync(join(dir, ".storybloq-version"), "0.0.1\n");
    refreshOwner.override = () => "foreign";
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(false);
    expect(existsSync(ownershipCachePath())).toBe(false);
  });
});
