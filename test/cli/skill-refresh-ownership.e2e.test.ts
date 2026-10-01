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
import { chmod, cp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2ECliFixture, runE2ECli, type RunE2ECliResult } from "../helpers/e2e-cli.js";
import { SKILL_FINGERPRINT_FILE } from "../../src/core/skill-version-marker.js";

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
    const global = join(fixture.root, "npm-global");
    const stubs = join(fixture.root, "npm-stub");
    await mkdir(join(global, "@storybloq"), { recursive: true });
    await mkdir(stubs, { recursive: true });
    await symlink(other, join(global, "@storybloq", "storybloq"));
    await writeFile(join(stubs, "npm"), `#!/bin/sh\necho '${global}'\n`, "utf-8");
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
});
