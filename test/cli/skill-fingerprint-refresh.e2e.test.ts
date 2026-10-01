/**
 * ISS-1302, end to end through the built CLI: a rebuild does not move the
 * package version, so the installed /story copy must follow the bundle's
 * content. This is the pen's post-rebuild live check as a test: a copy written
 * for the same version but another bundle (or before the fingerprint sidecar
 * existed) is refreshed by the next command of any kind, which says why, and
 * the command after it rewrites nothing.
 *
 * HOME is the fixture's own (E2ECliFixture), so the real skill copy is never
 * touched; the refresh notice is the point here, so this file does not assert
 * the fixture's no-housekeeping-notice rule.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2ECliFixture, runE2ECli } from "../helpers/e2e-cli.js";
import { skillSourceFingerprint, SKILL_FINGERPRINT_FILE } from "../../src/core/skill-version-marker.js";

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const BUNDLE = join(pkgRoot, "src", "skill");

async function cliVersion(): Promise<string> {
  return (JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf-8")) as { version: string }).version;
}

/**
 * ISS-1323: only the package `npm root -g` names may refresh, so the owner is
 * made explicit: an `npm` first on PATH whose global root links
 * @storybloq/storybloq to this package. Never borrowed from the machine, so a
 * standalone clone reads as the owner too.
 */
async function ownerEnv(fixture: E2ECliFixture): Promise<Record<string, string>> {
  const global = join(fixture.root, "npm-global");
  const stubs = join(fixture.root, "npm-stub");
  await mkdir(join(global, "@storybloq"), { recursive: true });
  await mkdir(stubs, { recursive: true });
  await symlink(pkgRoot, join(global, "@storybloq", "storybloq"));
  await writeFile(join(stubs, "npm"), `#!/bin/sh\necho '${global}'\n`, "utf-8");
  await chmod(join(stubs, "npm"), 0o755);
  return { PATH: [stubs, process.env.PATH ?? ""].join(delimiter) };
}

describe("ISS-1302: any command refreshes a same-version copy whose bundle changed", () => {
  let fixture: E2ECliFixture;
  let skillDir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    fixture = await E2ECliFixture.create();
    skillDir = join(fixture.home, ".claude", "skills", "story");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# a copy written before duet spawn existed\n", "utf-8");
    await writeFile(join(skillDir, ".storybloq-version"), `${await cliVersion()}\n`, "utf-8");
    env = await ownerEnv(fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("a copy from before the sidecar (the live machine today): the first command refreshes it with the same-version line, the second rewrites nothing", async () => {
    const version = await cliVersion();
    const line = `refreshed skill files at ~/.claude/skills/story/ to match CLI v${version} (same version, bundled skill changed)`;
    const first = runE2ECli(fixture, ["reference", "--format", "json"], { env });
    expect(first.status).toBe(0);
    expect(first.stderr).toContain(line);
    expect(await readFile(join(skillDir, "SKILL.md"), "utf-8")).toBe(await readFile(join(BUNDLE, "SKILL.md"), "utf-8"));
    expect(await readFile(join(skillDir, "duet-mode.md"), "utf-8")).toBe(await readFile(join(BUNDLE, "duet-mode.md"), "utf-8"));
    expect((await readFile(join(skillDir, SKILL_FINGERPRINT_FILE), "utf-8")).trim()).toBe(skillSourceFingerprint(BUNDLE));
    expect(await readFile(join(skillDir, ".storybloq-version"), "utf-8")).toBe(`${version}\n`);
    const before = (await stat(join(skillDir, "SKILL.md"))).mtimeMs;

    const second = runE2ECli(fixture, ["reference", "--format", "json"], { env });
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain("refreshed skill files");
    expect(second.stderr).not.toContain("(same version, bundled skill changed)");
    expect((await stat(join(skillDir, "SKILL.md"))).mtimeMs).toBe(before);
  });

  it("a copy recorded against another bundle (one byte moved since it was written) is refreshed by the next command", async () => {
    const other = "sha256:" + "0".repeat(64);
    expect(other).not.toBe(skillSourceFingerprint(BUNDLE));
    await writeFile(join(skillDir, SKILL_FINGERPRINT_FILE), `${other}\n`, "utf-8");
    const res = runE2ECli(fixture, ["reference", "--format", "json"], { env });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("(same version, bundled skill changed)");
    expect((await readFile(join(skillDir, SKILL_FINGERPRINT_FILE), "utf-8")).trim()).toBe(skillSourceFingerprint(BUNDLE));
  });
});

// setup-skill is the manual override. It records the same fingerprint beside
// each marker it writes, so the command after a setup never rewrites the copy
// the setup just made. Through the built CLI: in the source layout the setup's
// marker write reads a package.json that is not there and writes nothing.
describe("ISS-1302: setup records the bundle fingerprint beside every marker it writes", () => {
  let fixture: E2ECliFixture;

  beforeEach(async () => {
    fixture = await E2ECliFixture.create();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("claude and codex setup write the sidecar for every target they install, and the next command refreshes nothing", async () => {
    const version = await cliVersion();
    // Shims first on PATH: setup registers with whatever `claude` and `codex`
    // it finds, and a real client must never see this fixture.
    const shims = join(fixture.root, "shims");
    await mkdir(shims, { recursive: true });
    for (const name of ["storybloq", "claude", "codex"]) {
      await writeFile(join(shims, name), "#!/bin/sh\nexit 0\n", "utf-8");
      await chmod(join(shims, name), 0o755);
    }
    const env = { PATH: [shims, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) };
    // An existing compat copy is refreshed by codex setup. Its marker names a
    // newer version so the pre-command refresh (which never writes over a
    // newer copy) leaves it to the setup under test.
    const compat = join(fixture.codexHome, "skills", "story");
    await mkdir(compat, { recursive: true });
    await writeFile(join(compat, "SKILL.md"), "# old\n", "utf-8");
    await writeFile(join(compat, ".storybloq-version"), "99.0.0\n", "utf-8");

    const expected = skillSourceFingerprint(BUNDLE);
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Each setup is read right after it runs: the next command's pre-command
    // refresh would otherwise heal a missing sidecar and hide the writer.
    const claude = runE2ECli(fixture, ["setup", "--client", "claude", "--skip-hooks"], { env });
    expect(claude.status, claude.stderr).toBe(0);
    const claudeDir = join(fixture.home, ".claude", "skills", "story");
    expect((await readFile(join(claudeDir, SKILL_FINGERPRINT_FILE), "utf-8")).trim()).toBe(expected);
    const codex = runE2ECli(fixture, ["setup", "--client", "codex", "--skip-hooks"], { env });
    expect(codex.status, codex.stderr).toBe(0);
    expect(codex.stderr).not.toContain("refreshed skill files");

    for (const dir of [claudeDir, join(fixture.home, ".agents", "skills", "story"), compat]) {
      expect(await readFile(join(dir, ".storybloq-version"), "utf-8"), dir).toBe(`${version}\n`);
      expect((await readFile(join(dir, SKILL_FINGERPRINT_FILE), "utf-8")).trim(), dir).toBe(expected);
    }

    const next = runE2ECli(fixture, ["reference", "--format", "json"], { env });
    expect(next.status).toBe(0);
    expect(next.stderr).not.toContain("refreshed skill files");
  });
});
